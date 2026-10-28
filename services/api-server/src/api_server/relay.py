"""NATS 事件按契约 WsFrame 的频道说明转发到 WS /ws，并据此更新设备状态（HYD-PLAN-007 §2、§3）。"""

import asyncio
import time

from pydantic import BaseModel

from api_server.devices import Devices
from api_server.ws import Hub
from py_common.bus import Bus
from py_contracts.api import Device, WsFrame
from py_contracts.events.hyd_security_alert_v1_schema import SecurityAlertV1
from py_contracts.events.hyd_vision_behavior_v1_schema import VisionBehaviorV1
from py_contracts.events.hyd_vision_track_v1_schema import VisionTrackV1

EXPIRE_TICK_S = 1.0  # 检查告警态是否到期解除的周期


def _frame(channel: str, model: BaseModel) -> WsFrame:
    return WsFrame(channel=channel, data=model.model_dump(mode="json"))


def _push(hub: Hub, device: Device | None) -> None:
    if device is not None:
        hub.broadcast(_frame("devices", device))


async def start(bus: Bus, hub: Hub, devices: Devices) -> None:
    async def on_track(event: VisionTrackV1) -> None:
        hub.broadcast(_frame("tracks", event))

    # 先推行为事件与告警、再推设备：设备变色时事件卡内容已就绪
    async def on_behavior(event: VisionBehaviorV1) -> None:
        hub.broadcast(_frame("alerts", event))
        _push(hub, devices.on_behavior(event, time.monotonic()))

    async def on_alert(event: SecurityAlertV1) -> None:
        hub.broadcast(_frame("alerts", event))
        _push(hub, devices.on_alert(event, time.monotonic()))

    await bus.subscribe("hyd.vision.track.v1", VisionTrackV1, on_track)
    await bus.subscribe("hyd.vision.behavior.v1", VisionBehaviorV1, on_behavior)
    await bus.subscribe("hyd.security.alert.v1", SecurityAlertV1, on_alert)


async def expire(hub: Hub, devices: Devices) -> None:
    while True:
        await asyncio.sleep(EXPIRE_TICK_S)
        for device in devices.expire(time.monotonic()):
            _push(hub, device)
