"""NATS 事件按契约 WsFrame 的频道说明转发到 WS /ws（HYD-PLAN-007 §2、§3）。"""

from collections.abc import Awaitable, Callable

from api_server.ws import Hub
from py_common.bus import Bus
from py_contracts.api import WsFrame
from py_contracts.events.event_base_schema import EventBase
from py_contracts.events.hyd_security_alert_v1_schema import SecurityAlertV1
from py_contracts.events.hyd_vision_behavior_v1_schema import VisionBehaviorV1
from py_contracts.events.hyd_vision_track_v1_schema import VisionTrackV1


def _forward(hub: Hub, channel: str) -> Callable[[EventBase], Awaitable[None]]:
    async def handler(event: EventBase) -> None:
        hub.broadcast(WsFrame(channel=channel, data=event.model_dump(mode="json")))

    return handler


async def start(bus: Bus, hub: Hub) -> None:
    await bus.subscribe("hyd.vision.track.v1", VisionTrackV1, _forward(hub, "tracks"))
    await bus.subscribe("hyd.vision.behavior.v1", VisionBehaviorV1, _forward(hub, "alerts"))
    await bus.subscribe("hyd.security.alert.v1", SecurityAlertV1, _forward(hub, "alerts"))
