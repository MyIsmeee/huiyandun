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
import yaml
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import load_pem_private_key
from fastapi import FastAPI, HTTPException, Response
from pydantic import Field

from evidence_service.recording import Evidence
from evidence_service.store import Chain
from py_common.bus import Bus
from py_common.config import ServiceConfig, load_config
from py_common.log import configure_logging
from py_contracts.config.site_schema import SiteConfig
from py_contracts.events.event_base_schema import EventBase
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
    site_file: Path = Field(Path("/etc/hyd/site.yaml"), description="站点配置：摄像头的流名")
    recorder_url: str = Field("http://recorder:9996", description="recorder 回放接口地址")
    recorder_timeout_s: float = Field(
        30.0, gt=0, le=300, description="向 recorder 取一段录像的超时，单位秒"
    )


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
    site = SiteConfig.model_validate(yaml.safe_load(config.site_file.read_text(encoding="utf-8")))
    chain = Chain(config.data_dir, load_key(config.signing_key_file))
    recorder = httpx2.AsyncClient(base_url=config.recorder_url, timeout=config.recorder_timeout_s)
    evidence = Evidence(chain, {c.id: c.stream for c in site.cameras}, recorder)
    bus = await Bus.connect(
        config.nats_url, name="evidence-service", timeout_s=config.nats_timeout_s
    )
    follow_task = asyncio.create_task(follow(evidence, bus))
    # log_config=None：uvicorn 的日志沿用根 logger 的 JSON 格式（CD-06）
    server = uvicorn.Server(
        uvicorn.Config(create_app(evidence), host="0.0.0.0", port=config.port, log_config=None)
    )
    log.info("evidence.started", extra={"incidents": len(chain.incidents)})
    try:
        await server.serve()
    finally:
        follow_task.cancel()
        await bus.close()
        await recorder.aclose()


def main() -> None:
    """hyd-evidence：常驻存证服务。"""
    config = load_config(EvidenceConfig)
    configure_logging("evidence-service", config.log_level)
    asyncio.run(serve(config))
