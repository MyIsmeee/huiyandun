"""evidence-service（TK-080，设计 080-evidence.md §3）：订阅事件写入存证（FR-701）；内部接口供 api-server
导出证据包（FR-702）。存证唯一写入方（D-04）。
"""

import asyncio
import logging
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx2
import nats
import uvicorn
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import load_pem_private_key
from fastapi import FastAPI, HTTPException, Response
from pydantic import Field

from evidence_service.recording import Evidence, sync_recorder
from evidence_service.store import Chain
from py_common.bus import Bus
from py_common.config import ServiceConfig, load_config
from py_common.log import configure_logging
from py_contracts.events.event_base_schema import EventBase
from py_contracts.events.hyd_config_cameras_v1_schema import ConfigCamerasV1
from py_contracts.events.hyd_correlator_incident_v1_schema import CorrelatorIncidentV1
from py_contracts.events.hyd_security_alert_v1_schema import SecurityAlertV1
from py_contracts.events.hyd_vision_behavior_v1_schema import VisionBehaviorV1
from py_contracts.events.hyd_vision_integrity_v1_schema import VisionIntegrityV1

# 重启后重放范围不超过 recorder 的录像保留期（20 分钟）
REPLAY = timedelta(minutes=15)
SUBSCRIBE_WAIT_S = 30.0  # 先订阅命中事件，最多等这么久再订阅关联事件（生产者未启动时流不存在）
RESUBSCRIBE_S = 5.0
EVENTS = {
    "hyd.security.alert.v1": ("alert", SecurityAlertV1),
    "hyd.vision.behavior.v1": ("behavior", VisionBehaviorV1),
    "hyd.vision.integrity.v1": ("integrity", VisionIntegrityV1),
}
INCIDENT_SUBJECT = "hyd.correlator.incident.v1"

log = logging.getLogger(__name__)


class EvidenceConfig(ServiceConfig):
    port: int = Field(8200, ge=1, le=65535, description="内部 HTTP 监听端口，只供 api-server 导出")
    data_dir: Path = Field(
        Path("/var/lib/hyd-evidence"), description="存证目录：chain.jsonl 与 objects/（080 §3.2）"
    )
    signing_key_file: Path = Field(
        Path("/run/secrets/evidence_signing_key"), description="存证签名的 Ed25519 私钥（PEM）"
    )
    recorder_api_url: str = Field(
        "http://recorder:9997",
        description="recorder 的配置接口地址：按摄像头登记表增删录像路径（D-101）",
    )
    go2rtc_rtsp: str = Field(
        "rtsp://go2rtc:8554", description="recorder 取流的 go2rtc RTSP 地址，流名即摄像头编号"
    )
    recorder_url: str = Field("http://recorder:9996", description="recorder 回放接口地址")
    recorder_timeout_s: float = Field(
        30.0, gt=0, le=300, description="向 recorder 取一段录像的超时，单位秒"
    )


REGISTRY_SUBJECT = "hyd.config.cameras.v1"  # 摄像头登记表，流中只保留最新一条（D-101）
# recorder 可能晚于登记表启动，重启会丢掉经接口添加的录像路径：定期比对补齐
RECORDER_SYNC_S = 30


async def follow_registry(
    cameras: dict[str, str], recorder_api: httpx2.AsyncClient, bus: Bus, go2rtc_rtsp: str
) -> None:
    """摄像头登记表变化时更新摄像头表，并让 recorder 只录登记的摄像头；之后每 30 s 按当前摄像头表
    比对一次 recorder，其暂不可达或重启丢失路径时下轮补齐。"""
    lock = asyncio.Lock()  # 登记表下发与定期比对不并发改 recorder
    registered = asyncio.Event()  # 收到登记表之前不比对：空表会删掉全部录像路径

    async def sync() -> None:
        async with lock:
            try:
                await sync_recorder(recorder_api, list(cameras), go2rtc_rtsp)
            except (httpx2.HTTPError, KeyError) as e:
                log.warning("evidence.recorder_sync_failed", extra={"error": repr(e)})

    async def on_registry(event: ConfigCamerasV1) -> None:
        cameras.clear()
        cameras.update({c.id: c.id for c in event.cameras})  # 录像路径名即摄像头编号
        registered.set()
        await sync()

    await _subscribe(
        bus, REGISTRY_SUBJECT, ConfigCamerasV1, on_registry, datetime.fromtimestamp(0, UTC)
    )
    while True:
        await asyncio.sleep(RECORDER_SYNC_S)
        if registered.is_set():
            await sync()


async def follow(evidence: Evidence, bus: Bus) -> None:
    """先订阅命中事件（缓存），再订阅关联事件：重放的关联事件能在缓存中找到命中事件。"""
    since = datetime.now(UTC) - REPLAY
    events = [
        asyncio.create_task(_subscribe(bus, subject, model, _cacher(evidence, kind), since))
        for subject, (kind, model) in EVENTS.items()
    ]
    await asyncio.wait(events, timeout=SUBSCRIBE_WAIT_S)
    await _subscribe(bus, INCIDENT_SUBJECT, CorrelatorIncidentV1, evidence.on_incident, since)
    await asyncio.gather(*events)


def _cacher(evidence: Evidence, kind: str) -> Callable[[EventBase], Awaitable[None]]:
    async def handler(event: EventBase) -> None:
        evidence.cache(kind, event)

    return handler


async def _subscribe[T: EventBase](
    bus: Bus, subject: str, model: type[T], handler: Callable[[T], Awaitable[None]], since: datetime
) -> None:
    while True:
        try:
            await bus.js_subscribe(subject, model, handler, since)
            return
        except (nats.errors.Error, TimeoutError) as e:
            log.warning("evidence.subscribe_failed", extra={"subject": subject, "error": repr(e)})
            await asyncio.sleep(RESUBSCRIBE_S)


def create_app(evidence: Evidence) -> FastAPI:
    app = FastAPI(openapi_url=None, docs_url=None, redoc_url=None)

    @app.get("/healthz")
    async def healthz() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/internal/incidents/{incident_id}/package")
    async def package(incident_id: str) -> Response:
        data = await evidence.package(incident_id)
        if data is None:
            raise HTTPException(404, "该关联事件没有存证记录")
        return Response(data, media_type="application/zip")

    return app


def load_key(path: Path) -> Ed25519PrivateKey:
    key = load_pem_private_key(path.read_bytes(), password=None)
    if not isinstance(key, Ed25519PrivateKey):
        raise TypeError(f"{path} 不是 Ed25519 私钥")
    return key


async def serve(config: EvidenceConfig) -> None:
    chain = Chain(config.data_dir, load_key(config.signing_key_file))
    recorder = httpx2.AsyncClient(base_url=config.recorder_url, timeout=config.recorder_timeout_s)
    recorder_api = httpx2.AsyncClient(
        base_url=config.recorder_api_url, timeout=config.recorder_timeout_s
    )
    cameras: dict[str, str] = {}
    evidence = Evidence(chain, cameras, recorder)
    bus = await Bus.connect(
        config.nats_url, name="evidence-service", timeout_s=config.nats_timeout_s
    )
    # 登记表的流由 api-server 创建：在后台订阅，不推迟内部接口就绪
    registry_task = asyncio.create_task(
        follow_registry(cameras, recorder_api, bus, config.go2rtc_rtsp)
    )
    follow_task = asyncio.create_task(follow(evidence, bus))
    # log_config=None：uvicorn 的日志沿用根 logger 的 JSON 格式（CD-06）
    server = uvicorn.Server(
        uvicorn.Config(create_app(evidence), host="0.0.0.0", port=config.port, log_config=None)
    )
    # 公钥指纹是校验证据包的信任起点：包内自带公钥，须与此处另行记下的值比对（080 §4）
    log.info(
        "evidence.started",
        extra={"incidents": len(chain.incidents), "public_key_fingerprint": chain.fingerprint},
    )
    try:
        await server.serve()
    finally:
        follow_task.cancel()
        registry_task.cancel()
        await bus.close()
        await recorder.aclose()
        await recorder_api.aclose()


def main() -> None:
    """hyd-evidence：常驻存证服务。"""
    config = load_config(EvidenceConfig)
    configure_logging("evidence-service", config.log_level)
    asyncio.run(serve(config))
