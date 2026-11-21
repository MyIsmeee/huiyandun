"""notifier：确认级物理告警（行为、区域入侵与越线）与高等级关联事件推送到企业微信、钉钉群机器人或通用 Webhook。

可选部署（compose.notify.yaml）：只有它接入出站网络，默认部署中不存在（DP-05 例外，同 llm-gateway）。
机器人地址含密钥，放在本机密钥文件（G-14）；未配置时只记一条日志后空转。
同一摄像头、同一类告警在冷却时间内只推一次；每个机器人每分钟至多推 RATE_PER_MIN 条（平台限流约 20 条/分钟），
超出的丢弃并记日志：控制台告警栏与弹窗不受影响。
"""

import asyncio
import logging
import time
from collections import deque
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx2
import nats
import yaml
from pydantic import BaseModel, ConfigDict, Field

from notifier.messages import Kind, Notice, notice, request
from py_common.bus import Bus
from py_common.config import ServiceConfig, load_config
from py_common.log import configure_logging
from py_contracts.events.event_base_schema import EventBase
from py_contracts.events.hyd_config_cameras_v1_schema import ConfigCamerasV1
from py_contracts.events.hyd_correlator_incident_v1_schema import CorrelatorIncidentV1
from py_contracts.events.hyd_vision_behavior_v1_schema import VisionBehaviorV1
from py_contracts.events.hyd_vision_rule_v1_schema import VisionRuleV1

RATE_PER_MIN = 18
RESUBSCRIBE_S = 5.0
SUBJECTS: dict[str, type[EventBase]] = {
    "hyd.vision.behavior.v1": VisionBehaviorV1,
    "hyd.vision.rule.v1": VisionRuleV1,
    "hyd.correlator.incident.v1": CorrelatorIncidentV1,
}
REGISTRY_SUBJECT = "hyd.config.cameras.v1"

log = logging.getLogger(__name__)


class NotifierConfig(ServiceConfig):
    targets_file: Path = Field(
        Path("/run/secrets/notify_targets"),
        description="机器人列表（YAML）：每项 kind（wecom、dingtalk、webhook）、url，钉钉可另给加签密钥 secret",
    )
    console_url: str | None = Field(
        None, description="控制台地址，写进通知里的处置链接；不给则不附链接"
    )
    cooldown_s: float = Field(
        60.0, ge=0, le=3600, description="同一摄像头、同一类告警的通知冷却时间，单位秒"
    )
    display_utc_offset_min: int = Field(
        480, ge=-720, le=840, description="通知中时间的时区偏移（分钟），默认东八区"
    )
    timeout_s: float = Field(5.0, gt=0, le=30, description="每次推送的超时，单位秒")


class Target(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    kind: Kind
    url: str = Field(pattern=r"^https?://")
    secret: str | None = None


def load_targets(path: Path) -> list[Target]:
    """文件不存在或为空时为空列表（不推送）；格式错误时报错退出，不静默丢通知。"""
    if not path.exists():
        return []
    raw = yaml.safe_load(path.read_text(encoding="utf-8")) or []
    return [Target.model_validate(item) for item in raw]


class Notifier:
    def __init__(
        self, config: NotifierConfig, targets: list[Target], client: httpx2.AsyncClient
    ) -> None:
        self._config = config
        self._targets = targets
        self._client = client
        self._last: dict[str, float] = {}
        self._sent: dict[str, deque[float]] = {t.url: deque() for t in targets}
        self.names: dict[str, str] = {}

    def due(self, n: Notice, now: float) -> bool:
        """冷却期内的同类告警不推送。"""
        last = self._last.get(n.key)
        if last is not None and now - last < self._config.cooldown_s:
            return False
        self._last[n.key] = now
        return True

    async def on_event(self, event: EventBase) -> None:
        # 重放的历史事件不推：只推订阅建立之后发生的
        if datetime.now(UTC) - event.ts > timedelta(minutes=2):
            return
        n = notice(event, self.names, self._config.display_utc_offset_min)  # type: ignore[arg-type]
        if n is None or not self.due(n, time.monotonic()):
            return
        await asyncio.gather(*(self._send(t, n) for t in self._targets))

    async def _send(self, target: Target, n: Notice) -> None:
        now = time.monotonic()
        sent = self._sent[target.url]
        while sent and now - sent[0] > 60:
            sent.popleft()
        if len(sent) >= RATE_PER_MIN:
            log.warning("notifier.rate_limited", extra={"kind": target.kind, "title": n.title})
            return
        sent.append(now)
        url, body = request(target.kind, target.url, target.secret, n, self._config.console_url)
        try:
            res = await self._client.post(url, json=body)
            reply: Any = {}
            if res.headers.get("content-type", "").startswith("application/json"):
                try:
                    reply = res.json()
                except ValueError:  # 声明为 JSON 而内容损坏（如代理的错误页）：按原文记录
                    reply = res.text
            # 企业微信、钉钉出错时也回 200，以 errcode 区分
            if res.status_code >= 400 or (isinstance(reply, dict) and reply.get("errcode", 0) != 0):
                log.warning(
                    "notifier.rejected",
                    extra={
                        "kind": target.kind,
                        "status": res.status_code,
                        "reply": str(reply)[:200],
                    },
                )
                return
        except httpx2.HTTPError as e:
            log.warning("notifier.send_failed", extra={"kind": target.kind, "error": repr(e)})
            return
        log.info("notifier.sent", extra={"kind": target.kind, "title": n.title})

    async def on_registry(self, event: ConfigCamerasV1) -> None:
        self.names = {c.id: c.name or c.id for c in event.cameras}


async def _subscribe[T: EventBase](
    bus: Bus, subject: str, model: type[T], handler: Any, since: datetime
) -> None:
    while True:
        try:
            await bus.js_subscribe(subject, model, handler, since)
            return
        except (nats.errors.Error, TimeoutError) as e:
            log.warning("notifier.subscribe_failed", extra={"subject": subject, "error": repr(e)})
            await asyncio.sleep(RESUBSCRIBE_S)


async def serve(config: NotifierConfig) -> None:
    targets = load_targets(config.targets_file)
    if not targets:
        log.info("notifier.disabled", extra={"targets_file": str(config.targets_file)})
        await asyncio.Event().wait()
    async with httpx2.AsyncClient(timeout=config.timeout_s) as client:
        notifier = Notifier(config, targets, client)
        bus = await Bus.connect(config.nats_url, name="notifier", timeout_s=config.nats_timeout_s)
        now = datetime.now(UTC)
        tasks = [
            asyncio.create_task(
                _subscribe(
                    bus,
                    REGISTRY_SUBJECT,
                    ConfigCamerasV1,
                    notifier.on_registry,
                    datetime.fromtimestamp(0, UTC),
                )
            )
        ]
        tasks += [
            asyncio.create_task(_subscribe(bus, s, m, notifier.on_event, now))
            for s, m in SUBJECTS.items()
        ]
        log.info("notifier.started", extra={"targets": [t.kind for t in targets]})
        try:
            await asyncio.Event().wait()
        finally:
            for task in tasks:
                task.cancel()
            await bus.close()


def main() -> None:
    """hyd-notifier：常驻通知服务。"""
    config = load_config(NotifierConfig)
    configure_logging("notifier", config.log_level)
    asyncio.run(serve(config))
