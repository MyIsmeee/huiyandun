"""关联引擎接入 NATS（TK-041）：对真实 nats-server 运行。"""

import asyncio
import json
import logging
from datetime import UTC, datetime, timedelta
from pathlib import Path

import nats
import pytest
from test_engine import T0, alert, integrity

from correlator import service
from correlator.engine import Engine
from correlator.rules import load_rules
from correlator.service import (
    INCIDENT_MAX_AGE_S,
    INCIDENT_STREAM,
    INCIDENT_SUBJECT,
    STREAM,
    STREAM_MAX_AGE_S,
    SUBJECT,
    correlate,
)
from py_common.bus import Bus
from py_contracts.events.hyd_correlator_incident_v1_schema import CorrelatorIncidentV1

ROOT = Path(__file__).resolve().parents[3]
RULES = load_rules(ROOT / "rules/correlator")
ATTACK = json.loads((ROOT / "rules/attack/techniques.json").read_text(encoding="utf-8"))
INTEGRITY = "hyd.vision.integrity.v1"
VISION_SUBJECTS = ["hyd.vision.behavior.v1", INTEGRITY]
WINDOW = timedelta(seconds=300)


def now_offset() -> float:
    """测试事件的 ts 取当前时刻附近：重启后按"当前时刻 − 窗口"重放，按事件 ts 匹配。"""
    return (datetime.now(UTC) - T0).total_seconds()


def test_incident_published_once_and_not_again_after_restart(nats_url: str) -> None:
    async def scenario() -> tuple[CorrelatorIncidentV1, int]:
        bus = await Bus.connect(nats_url, name="test", timeout_s=2)
        await bus.ensure_stream(STREAM, [SUBJECT], STREAM_MAX_AGE_S)
        await bus.ensure_stream(INCIDENT_STREAM, [INCIDENT_SUBJECT], INCIDENT_MAX_AGE_S)
        await bus.ensure_stream("HYD_VISION", VISION_SUBJECTS, 3600)
        received: asyncio.Queue[CorrelatorIncidentV1] = asyncio.Queue()
        await bus.subscribe(INCIDENT_SUBJECT, CorrelatorIncidentV1, received.put)
        await correlate(Engine(RULES, ATTACK), bus, WINDOW)
        t = now_offset()
        await bus.js_publish(SUBJECT, alert(t))
        await bus.js_publish(INTEGRITY, integrity(t + 1))
        incident = await asyncio.wait_for(received.get(), 5)

        # 重启：新的引擎先从流中恢复去重状态，再重放窗口内的同一组事件，不再发布
        # （JetStream 的去重只管流内存储，重复发布仍会送达订阅方，故按收到的消息判断）
        restarted = await Bus.connect(nats_url, name="restarted", timeout_s=2)
        await correlate(Engine(RULES, ATTACK), restarted, WINDOW)
        await asyncio.sleep(0.5)
        republished = received.qsize()
        await restarted.close()
        await bus.close()
        return incident, republished

    incident, republished = asyncio.run(scenario())
    assert (incident.rule_id, incident.device_ids, incident.requires_confirmation) == (
        "HYD-X-0001",
        ["cam-02"],
        False,
    )
    assert republished == 0


def test_missing_vision_stream_retried_until_created(
    nats_url: str, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """未启动 vision-engine 时视觉事件的流不存在：记录后重试，流创建后照常关联。"""
    monkeypatch.setattr(service, "RESUBSCRIBE_S", 0.1)

    async def scenario() -> CorrelatorIncidentV1:
        raw = await nats.connect(nats_url)
        for name in ("HYD_VISION", STREAM, INCIDENT_STREAM):  # 与其他用例隔离
            try:
                await raw.jetstream().delete_stream(name)
            except nats.js.errors.NotFoundError:
                pass
        await raw.close()
        bus = await Bus.connect(nats_url, name="test", timeout_s=2)
        await bus.ensure_stream(STREAM, [SUBJECT], STREAM_MAX_AGE_S)
        await bus.ensure_stream(INCIDENT_STREAM, [INCIDENT_SUBJECT], INCIDENT_MAX_AGE_S)
        received: asyncio.Queue[CorrelatorIncidentV1] = asyncio.Queue()
        await bus.subscribe(INCIDENT_SUBJECT, CorrelatorIncidentV1, received.put)
        task = asyncio.create_task(correlate(Engine(RULES, ATTACK), bus, WINDOW))
        await asyncio.sleep(0.3)
        await bus.ensure_stream("HYD_VISION", VISION_SUBJECTS, 3600)
        await asyncio.wait_for(task, 5)
        t = now_offset()
        await bus.js_publish(SUBJECT, alert(t))
        await bus.js_publish(INTEGRITY, integrity(t + 1))
        try:
            return await asyncio.wait_for(received.get(), 5)
        finally:
            await bus.close()

    with caplog.at_level(logging.WARNING):
        incident = asyncio.run(scenario())
    assert incident.rule_id == "HYD-X-0001"
    assert any(r.getMessage() == "correlator.stream_missing" for r in caplog.records)
