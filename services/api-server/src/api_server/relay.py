"""NATS 事件按契约 WsFrame 的频道说明转发到 WS /ws，并据此更新设备状态（architecture.md §12）。"""

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import Any

from pydantic import BaseModel

from api_server.devices import Devices
from api_server.history import WINDOW, History
from api_server.investigator import Investigator
from api_server.kpis import KpiTracker
from api_server.pose_checks import PoseChecks
from api_server.ws import Hub
from py_common.bus import Bus, js_subscribe_retrying
from py_common.demo_quiet import QuietPreset
from py_contracts.api import Device, WsFrame
from py_contracts.events.event_base_schema import EventBase
from py_contracts.events.hyd_correlator_incident_v1_schema import CorrelatorIncidentV1
from py_contracts.events.hyd_playbook_execution_v1_schema import PlaybookExecutionV1
from py_contracts.events.hyd_security_alert_v1_schema import SecurityAlertV1
from py_contracts.events.hyd_vision_behavior_v1_schema import VisionBehaviorV1
from py_contracts.events.hyd_vision_integrity_v1_schema import VisionIntegrityV1
from py_contracts.events.hyd_vision_pose_check_v1_schema import VisionPoseCheckV1
from py_contracts.events.hyd_vision_rule_v1_schema import VisionRuleV1
from py_contracts.events.hyd_vision_track_v1_schema import VisionTrackV1

EXPIRE_TICK_S = 1.0  # 检查告警态是否到期解除的周期
RESUBSCRIBE_S = 5.0  # 流尚未由生产者创建时按此间隔重试

log = logging.getLogger(__name__)


def _frame(channel: str, model: BaseModel) -> WsFrame:
    return WsFrame(channel=channel, data=model.model_dump(mode="json"))


def _push(hub: Hub, device: Device | None) -> None:
    if device is not None:
        hub.broadcast(_frame("devices", device))


async def start(
    bus: Bus,
    hub: Hub,
    devices: Devices,
    pose_checks: PoseChecks | None = None,
    on_geometry: Callable[[VisionPoseCheckV1], Awaitable[None]] | None = None,
    quiet: QuietPreset | None = None,
) -> None:
    """核心订阅只收实时事件；安装参数自检只记下每路最新一条，随摄像头列表给出；
    带单目几何估计的自检交给 on_geometry（自动标定写回，auto_pose.py）。
    演示静默的行为事件与告警不推送、不改变设备状态（py_common.demo_quiet）。"""

    def hidden(event: EventBase) -> bool:
        return quiet is not None and quiet.hides(event)

    async def on_track(event: VisionTrackV1) -> None:
        hub.broadcast(_frame("tracks", event))

    # 先推行为事件与告警、再推设备：设备变色时事件卡内容已就绪
    async def on_behavior(event: VisionBehaviorV1) -> None:
        if hidden(event):
            return
        hub.broadcast(_frame("alerts", event))
        _push(hub, devices.on_behavior(event, time.monotonic()))

    async def on_rule(event: VisionRuleV1) -> None:
        hub.broadcast(_frame("alerts", event))
        _push(hub, devices.on_rule(event, time.monotonic()))

    async def on_alert(event: SecurityAlertV1) -> None:
        if hidden(event):
            return
        hub.broadcast(_frame("alerts", event))
        _push(hub, devices.on_alert(event, time.monotonic()))

    async def on_integrity(event: VisionIntegrityV1) -> None:
        if event.type == "stream_lost":
            _push(hub, devices.on_stream_lost(event, time.monotonic()))

    await bus.subscribe("hyd.vision.track.v1", VisionTrackV1, on_track)
    if pose_checks is not None:

        async def on_pose_check(event: VisionPoseCheckV1) -> None:
            pose_checks.on_check(event)
            if on_geometry is not None and event.geometry is not None:
                try:
                    await on_geometry(event)
                except Exception:
                    log.exception("relay.auto_pose_failed", extra={"camera_id": event.camera_id})

        await bus.subscribe("hyd.vision.pose_check.v1", VisionPoseCheckV1, on_pose_check)
    await bus.subscribe("hyd.vision.behavior.v1", VisionBehaviorV1, on_behavior)
    await bus.subscribe("hyd.vision.rule.v1", VisionRuleV1, on_rule)
    await bus.subscribe("hyd.security.alert.v1", SecurityAlertV1, on_alert)
    # 只用核心订阅更新离线：JetStream 重放的历史断流不应把设备置为离线
    await bus.subscribe("hyd.vision.integrity.v1", VisionIntegrityV1, on_integrity)


async def follow(
    bus: Bus,
    hub: Hub,
    devices: Devices,
    history: History,
    investigator: Investigator,
    kpis: KpiTracker,
    quiet: QuietPreset | None = None,
) -> None:
    """从 JetStream 重放近 24 小时并持续接收（D-077）：告警与行为事件只记入历史（推送沿用 start 的转发）；
    画面完整性事件只记入历史，供报告查找（TK-070）；关联事件与处置执行记入历史并推送，执行同时更新设备的
    处置状态（ui.md §5.1）；关联事件另提交值班员调查（TK-116）。演示静默的告警与行为事件不记入历史。"""

    async def on_alert(event: EventBase) -> None:
        if quiet is not None and quiet.hides(event):
            return
        history.add_alert(event)

    async def on_integrity(event: EventBase) -> None:
        history.add_integrity(event)

    async def on_incident(event: CorrelatorIncidentV1) -> None:
        history.add_incident(event)
        hub.broadcast(_frame("incidents", event))
        investigator.submit(event)

    async def on_execution(event: PlaybookExecutionV1) -> None:
        history.add_execution(event)
        kpis.on_execution(event)
        hub.broadcast(_frame("executions", event))
        for device in devices.on_execution(event, time.monotonic()):
            _push(hub, device)

    since = datetime.now(UTC) - WINDOW
    subscriptions: list[tuple[str, type[EventBase], Callable[[Any], Awaitable[None]]]] = [
        ("hyd.security.alert.v1", SecurityAlertV1, on_alert),
        ("hyd.vision.behavior.v1", VisionBehaviorV1, on_alert),
        ("hyd.vision.rule.v1", VisionRuleV1, on_alert),
        ("hyd.vision.integrity.v1", VisionIntegrityV1, on_integrity),
        ("hyd.correlator.incident.v1", CorrelatorIncidentV1, on_incident),
        ("hyd.playbook.execution.v1", PlaybookExecutionV1, on_execution),
    ]
    await asyncio.gather(
        *(js_subscribe_retrying(bus, s, m, h, since, RESUBSCRIBE_S) for s, m, h in subscriptions)
    )


async def expire(hub: Hub, devices: Devices, kpis: KpiTracker) -> None:
    while True:
        await asyncio.sleep(EXPIRE_TICK_S)
        for device in devices.expire(time.monotonic()):
            _push(hub, device)
        kpis.tick(datetime.now(UTC))
