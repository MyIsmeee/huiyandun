"""correlator：归一化器（TK-032）与关联引擎（TK-041）。

归一化器跟随 Suricata EVE，逐条归一化后发布 hyd.security.alert.v1；每条告警经 JetStream 确认后才记录
读取位置，发布失败时保留该条，下个周期重试，不丢告警。

关联引擎从 JetStream 订阅告警与视觉事件，生成的关联事件发布到 hyd.correlator.incident.v1。重启时先重放
近期的关联事件恢复去重状态，再从"当前时刻 − 最长规则窗口"起重放事件恢复匹配窗口。
"""

import asyncio
import json
import logging
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime, timedelta
from functools import partial
from pathlib import Path

import nats
import nats.js.errors
import yaml
from pydantic import Field

from correlator.engine import SUPPRESS, Engine
from correlator.eve import EveTail, Line
from correlator.normalize import Ip, device_index, normalize
from correlator.rules import MODELS, Event, load_rules
from py_common.bus import Bus
from py_common.config import ServiceConfig, load_config
from py_common.log import configure_logging
from py_contracts.config.site_schema import SiteConfig
from py_contracts.events.hyd_correlator_incident_v1_schema import CorrelatorIncidentV1

SUBJECT = "hyd.security.alert.v1"
# 告警保留 365 天（HYD-ARCH-001 §10.2）
STREAM = "HYD_SECURITY"
STREAM_MAX_AGE_S = 365 * 86400
INCIDENT_SUBJECT = "hyd.correlator.incident.v1"
# 关联事件与处置记录同为 365 天（HYD-ARCH-001 §10.2）
INCIDENT_STREAM = "HYD_INCIDENT"
INCIDENT_MAX_AGE_S = 365 * 86400
RESUBSCRIBE_S = 5.0  # 视觉事件的流由 vision-engine 创建：尚未创建时按此间隔重试订阅
PUBLISH_ATTEMPTS = 3

log = logging.getLogger(__name__)


class CorrelatorConfig(ServiceConfig):
    eve_file: Path = Field(
        Path("/var/log/suricata/eve.json"), description="Suricata EVE 告警日志，只读挂载"
    )
    state_file: Path = Field(
        Path("/var/lib/correlator/eve-position.json"),
        description="EVE 已处理位置，须位于持久卷，重启后续读",
    )
    site_file: Path = Field(
        Path("/etc/hyd/site.yaml"), description="站点配置 site.yaml：设备登记表（FR-203）"
    )
    poll_s: float = Field(0.5, gt=0, le=10, description="读到文件末尾后再次检查的间隔，单位秒")
    heartbeat_file: Path = Field(
        Path("/tmp/hyd-correlator-alive"), description="每个周期更新其修改时间，供健康检查判断"
    )
    rules_dir: Path = Field(
        Path("/etc/hyd/rules"), description="关联规则目录 rules/correlator（HYD-PLAN-007 §4）"
    )
    attack_file: Path = Field(
        Path("/etc/hyd/attack.json"), description="ATT&CK 精简查表 rules/attack/techniques.json"
    )


async def run(tail: EveTail, devices: dict[Ip, str], bus: Bus, config: CorrelatorConfig) -> None:
    pending: list[Line] = []
    while True:
        config.heartbeat_file.touch()
        pending += await asyncio.to_thread(tail.poll)
        while pending:
            event = normalize(pending[0].text, devices)
            if event is not None:
                try:
                    await bus.js_publish(SUBJECT, event)
                except (nats.errors.Error, TimeoutError) as e:
                    # 断线本身已由 bus.disconnected 记录；每个周期重试一次，不重复输出堆栈
                    log.warning(
                        "correlator.publish_failed",
                        extra={"rule_id": event.rule_id, "error": repr(e)},
                    )
                    break
                log.info(
                    "correlator.alert_published",
                    extra={"rule_id": event.rule_id, "device_id": event.device_id},
                )
            await asyncio.to_thread(tail.commit, pending.pop(0))
        await asyncio.sleep(config.poll_s)


async def publish_incident(bus: Bus, incident: CorrelatorIncidentV1) -> None:
    for attempt in range(1, PUBLISH_ATTEMPTS + 1):
        try:
            await bus.js_publish(INCIDENT_SUBJECT, incident)
        except (nats.errors.Error, TimeoutError) as e:
            log.warning(
                "correlator.incident_publish_failed",
                extra={"incident_id": incident.id, "attempt": attempt, "error": repr(e)},
            )
            await asyncio.sleep(1)
            continue
        log.info(
            "correlator.incident_published",
            extra={
                "incident_id": incident.id,
                "rule_id": incident.rule_id,
                "device_ids": incident.device_ids,
                "requires_confirmation": incident.requires_confirmation,
            },
        )
        return
    log.error("correlator.incident_lost", extra={"incident_id": incident.id})


async def follow[T: Event](
    bus: Bus, subject: str, model: type[T], handler: Callable[[T], Awaitable[None]], since: datetime
) -> None:
    """订阅并重放 since 之后的事件；流尚未创建（如未启动 vision-engine）时记录并重试。"""
    while True:
        try:
            await bus.js_subscribe(subject, model, handler, since)
            return
        except nats.js.errors.NotFoundError:
            log.warning("correlator.stream_missing", extra={"subject": subject})
            await asyncio.sleep(RESUBSCRIBE_S)


async def correlate(engine: Engine, bus: Bus, window: timedelta) -> None:
    """建立关联引擎的订阅：先恢复去重状态，再重放并持续接收事件。"""
    started = datetime.now(UTC)

    async def restore(incident: CorrelatorIncidentV1) -> None:
        engine.restore(incident)

    await bus.js_subscribe(INCIDENT_SUBJECT, CorrelatorIncidentV1, restore, started - SUPPRESS)

    async def on_event(subject: str, event: Event) -> None:
        for incident in engine.feed(subject, event):
            await publish_incident(bus, incident)

    await asyncio.gather(
        *(
            follow(bus, subject, model, partial(on_event, subject), started - window)
            for subject, model in MODELS.items()
        )
    )


async def serve(config: CorrelatorConfig) -> None:
    site = SiteConfig.model_validate(yaml.safe_load(config.site_file.read_text(encoding="utf-8")))
    rules = load_rules(config.rules_dir)
    engine = Engine(rules, json.loads(config.attack_file.read_text(encoding="utf-8")))
    bus = await Bus.connect(config.nats_url, name="correlator", timeout_s=config.nats_timeout_s)
    await bus.ensure_stream(STREAM, [SUBJECT], STREAM_MAX_AGE_S)
    await bus.ensure_stream(INCIDENT_STREAM, [INCIDENT_SUBJECT], INCIDENT_MAX_AGE_S)
    log.info(
        "correlator.started",
        extra={"eve_file": str(config.eve_file), "rules": [r.id for r in rules]},
    )
    window = timedelta(seconds=max(r.window_s for r in rules))
    await asyncio.gather(
        correlate(engine, bus, window),
        run(EveTail(config.eve_file, config.state_file), device_index(site), bus, config),
    )


def main() -> None:
    """hyd-correlator：常驻归一化与关联。"""
    config = load_config(CorrelatorConfig)
    configure_logging("correlator", config.log_level)
    asyncio.run(serve(config))
