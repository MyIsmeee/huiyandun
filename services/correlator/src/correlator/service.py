"""correlator 归一化器（TK-032）：跟随 Suricata EVE，逐条归一化后发布 hyd.security.alert.v1。

每条告警经 JetStream 确认后才记录读取位置；发布失败时保留该条，下个周期重试，不丢告警。
"""

import asyncio
import logging
from pathlib import Path

import nats
import yaml
from pydantic import Field

from correlator.eve import EveTail, Line
from correlator.normalize import Ip, device_index, normalize
from py_common.bus import Bus
from py_common.config import ServiceConfig, load_config
from py_common.log import configure_logging
from py_contracts.config.site_schema import SiteConfig

SUBJECT = "hyd.security.alert.v1"
# 告警保留 365 天（HYD-ARCH-001 §10.2）
STREAM = "HYD_SECURITY"
STREAM_MAX_AGE_S = 365 * 86400

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
                except (nats.errors.Error, TimeoutError):
                    log.exception("correlator.publish_failed", extra={"rule_id": event.rule_id})
                    break
                log.info(
                    "correlator.alert_published",
                    extra={"rule_id": event.rule_id, "device_id": event.device_id},
                )
            await asyncio.to_thread(tail.commit, pending.pop(0))
        await asyncio.sleep(config.poll_s)


async def serve(config: CorrelatorConfig) -> None:
    site = SiteConfig.model_validate(yaml.safe_load(config.site_file.read_text(encoding="utf-8")))
    bus = await Bus.connect(config.nats_url, name="correlator", timeout_s=config.nats_timeout_s)
    await bus.ensure_stream(STREAM, [SUBJECT], STREAM_MAX_AGE_S)
    log.info("correlator.started", extra={"eve_file": str(config.eve_file)})
    await run(EveTail(config.eve_file, config.state_file), device_index(site), bus, config)


def main() -> None:
    """hyd-correlator：常驻归一化。"""
    config = load_config(CorrelatorConfig)
    configure_logging("correlator", config.log_level)
    asyncio.run(serve(config))
