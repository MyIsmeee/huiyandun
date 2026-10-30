"""NATS 事件按契约 WsFrame 的频道说明转发到 WS /ws，并据此更新设备状态（HYD-PLAN-007 §2、§3）。"""

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime

import nats
from pydantic import BaseModel

from api_server.devices import Devices
from api_server.history import WINDOW, History
from api_server.ws import Hub
from py_common.bus import Bus
from py_contracts.api import Device, WsFrame
from py_contracts.events.event_base_schema import EventBase
from py_contracts.events.hyd_correlator_incident_v1_schema import CorrelatorIncidentV1
from py_contracts.events.hyd_playbook_execution_v1_schema import PlaybookExecutionV1
from py_contracts.events.hyd_security_alert_v1_schema import SecurityAlertV1
from py_contracts.events.hyd_vision_behavior_v1_schema import VisionBehaviorV1
from py_contracts.events.hyd_vision_scene_v1_schema import VisionSceneV1
from py_contracts.events.hyd_vision_track_v1_schema import VisionTrackV1

EXPIRE_TICK_S = 1.0  # 检查告警态是否到期解除的周期
RESUBSCRIBE_S = 5.0  # 流尚未由生产者创建时按此间隔重试

log = logging.getLogger(__name__)


def _frame(channel: str, model: BaseModel) -> WsFrame:
    return WsFrame(channel=channel, data=model.model_dump(mode="json"))


def _push(hub: Hub, device: Device | None) -> None:
    if device is not None:
        hub.broadcast(_frame("devices", device))


async def start(bus: Bus, hub: Hub, devices: Devices, scenes: dict[str, WsFrame]) -> None:
    """scenes：各摄像头最新一帧场景，供新连接补推（只保留最新一帧，不持久化）。"""

    async def on_track(event: VisionTrackV1) -> None:
        hub.broadcast(_frame("tracks", event))

    async def on_scene(event: VisionSceneV1) -> None:
        scenes[event.camera_id] = _frame("scene", event)
        hub.broadcast(scenes[event.camera_id])

    # 先推行为事件与告警、再推设备：设备变色时事件卡内容已就绪
    async def on_behavior(event: VisionBehaviorV1) -> None:
        hub.broadcast(_frame("alerts", event))
        _push(hub, devices.on_behavior(event, time.monotonic()))

    async def on_alert(event: SecurityAlertV1) -> None:
        hub.broadcast(_frame("alerts", event))
        _push(hub, devices.on_alert(event, time.monotonic()))

    await bus.subscribe("hyd.vision.track.v1", VisionTrackV1, on_track)
    await bus.subscribe("hyd.vision.scene.v1", VisionSceneV1, on_scene)
    await bus.subscribe("hyd.vision.behavior.v1", VisionBehaviorV1, on_behavior)
    await bus.subscribe("hyd.security.alert.v1", SecurityAlertV1, on_alert)


async def follow(bus: Bus, hub: Hub, devices: Devices, history: History) -> None:
    """从 JetStream 重放近 24 小时并持续接收（D-077）：告警与行为事件只记入历史（推送沿用 start 的转发）；
    关联事件与处置执行记入历史并推送，执行同时更新设备的处置状态（04 §5.2）。"""

    async def on_alert(event: EventBase) -> None:
        history.add_alert(event)

    async def on_incident(event: CorrelatorIncidentV1) -> None:
        history.add_incident(event)
        hub.broadcast(_frame("incidents", event))

    async def on_execution(event: PlaybookExecutionV1) -> None:
        history.add_execution(event)
        hub.broadcast(_frame("executions", event))
        for device in devices.on_execution(event, time.monotonic()):
            _push(hub, device)

    since = datetime.now(UTC) - WINDOW
    await asyncio.gather(
        _subscribe(bus, "hyd.security.alert.v1", SecurityAlertV1, on_alert, since),
        _subscribe(bus, "hyd.vision.behavior.v1", VisionBehaviorV1, on_alert, since),
        _subscribe(bus, "hyd.correlator.incident.v1", CorrelatorIncidentV1, on_incident, since),
        _subscribe(bus, "hyd.playbook.execution.v1", PlaybookExecutionV1, on_execution, since),
    )


async def _subscribe[T: EventBase](
    bus: Bus, subject: str, model: type[T], handler: Callable[[T], Awaitable[None]], since: datetime
) -> None:
    while True:
        try:
            await bus.js_subscribe(subject, model, handler, since)
            return
        except (nats.errors.Error, TimeoutError) as e:
            log.warning(
                "api.history_subscribe_failed", extra={"subject": subject, "error": repr(e)}
            )
            await asyncio.sleep(RESUBSCRIBE_S)


async def expire(hub: Hub, devices: Devices) -> None:
    while True:
        await asyncio.sleep(EXPIRE_TICK_S)
        for device in devices.expire(time.monotonic()):
            _push(hub, device)
