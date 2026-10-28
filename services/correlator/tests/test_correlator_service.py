"""归一化器主循环：EVE 文件 → NATS hyd.security.alert.v1（TK-032）。"""

import asyncio
import threading
from pathlib import Path
from typing import cast

import yaml

from correlator.eve import EveTail, Line
from correlator.normalize import device_index
from correlator.service import STREAM, STREAM_MAX_AGE_S, SUBJECT, CorrelatorConfig, run
from py_common.bus import Bus
from py_contracts.config.site_schema import SiteConfig
from py_contracts.events.hyd_security_alert_v1_schema import SecurityAlertV1

ROOT = Path(__file__).resolve().parents[3]
LIVE = (Path(__file__).parent / "eve/live.json").read_text(encoding="utf-8").strip()
DEVICES = device_index(
    SiteConfig.model_validate(
        yaml.safe_load((ROOT / "demo/scenarios/site.yaml").read_text(encoding="utf-8"))
    )
)


def config(tmp_path: Path) -> CorrelatorConfig:
    return CorrelatorConfig(
        eve_file=tmp_path / "eve.json",
        state_file=tmp_path / "position.json",
        poll_s=0.05,
        heartbeat_file=tmp_path / "alive",
    )


def write_eve(path: Path, *lines: str) -> None:
    path.write_text("".join(f"{line}\n" for line in lines), encoding="utf-8")


class CommitWatch(EveTail):
    """确认到文件末尾时置位；commit 在工作线程中调用，故用 threading.Event。"""

    def __init__(self, cfg: CorrelatorConfig) -> None:
        super().__init__(cfg.eve_file, cfg.state_file)
        self.size = cfg.eve_file.stat().st_size
        self.at_end = threading.Event()

    def commit(self, line: Line) -> None:
        super().commit(line)
        if line.end == self.size:
            self.at_end.set()


def test_publishes_normalized_alert(nats_url: str, tmp_path: Path) -> None:
    cfg = config(tmp_path)
    write_eve(cfg.eve_file, '{"event_type": "stats"}', LIVE)

    async def scenario() -> SecurityAlertV1:
        bus = await Bus.connect(nats_url, name="test", timeout_s=2)
        await bus.ensure_stream(STREAM, [SUBJECT], STREAM_MAX_AGE_S)
        received: asyncio.Queue[SecurityAlertV1] = asyncio.Queue()
        await bus.subscribe(SUBJECT, SecurityAlertV1, received.put)
        tail = CommitWatch(cfg)
        task = asyncio.create_task(run(tail, DEVICES, bus, cfg))
        try:
            alert = await asyncio.wait_for(received.get(), 5)
            # 两行（含不合格的一行）都已确认，重启后不会重读
            assert await asyncio.to_thread(tail.at_end.wait, 5)
            return alert
        finally:
            task.cancel()
            tail.close()
            await bus.close()

    alert = asyncio.run(scenario())
    assert (alert.rule_id, alert.device_id, str(alert.src_ip)) == (
        "HYD-NET-0001",
        "cam-02",
        "172.30.0.100",
    )


class FlakyBus:
    """第一次发布超时，之后成功。"""

    def __init__(self) -> None:
        self.attempts: list[SecurityAlertV1] = []
        self.published = asyncio.Event()

    async def js_publish(self, subject: str, event: SecurityAlertV1) -> None:
        self.attempts.append(event)
        if len(self.attempts) == 1:
            raise TimeoutError
        self.published.set()


def test_publish_failure_retried_without_loss(tmp_path: Path) -> None:
    """发布失败时不确认该行，下个周期重试；同一行的 event_id 不变，重试不会产生重复告警。"""
    cfg = config(tmp_path)
    write_eve(cfg.eve_file, LIVE)

    async def scenario() -> list[SecurityAlertV1]:
        bus = FlakyBus()
        tail = EveTail(cfg.eve_file, cfg.state_file)
        task = asyncio.create_task(run(tail, DEVICES, cast(Bus, bus), cfg))
        try:
            await asyncio.wait_for(bus.published.wait(), 5)
            return bus.attempts
        finally:
            task.cancel()
            tail.close()

    first, retry = asyncio.run(scenario())
    assert first.event_id == retry.event_id
