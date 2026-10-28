"""NATS 事件按契约 WsFrame 的频道说明转发到 WS /ws（#54）。"""

import asyncio
import uuid
from collections.abc import Iterator
from datetime import UTC, datetime
from typing import Any

import pytest
from fastapi.testclient import TestClient
from starlette.testclient import WebSocketTestSession

from api_server import ws as ws_module
from api_server.app import create_app
from api_server.config import ApiConfig
from py_common.bus import Bus
from py_contracts.api import WsFrame
from py_contracts.events.event_base_schema import EventBase
from py_contracts.events.hyd_security_alert_v1_schema import SecurityAlertV1
from py_contracts.events.hyd_vision_behavior_v1_schema import VisionBehaviorV1
from py_contracts.events.hyd_vision_track_v1_schema import VisionTrackV1

WS_URL = "wss://testserver/ws"
SENTINEL = WsFrame(channel="system", data={"type": "sentinel"})


def common() -> dict[str, Any]:
    return {"schema_version": "1.0.0", "event_id": uuid.uuid4(), "ts": datetime.now(UTC)}


def track() -> VisionTrackV1:
    return VisionTrackV1(
        **common(), camera_id="cam-01", track_id=1, x=4.0, y=6.0, uncertainty_m=0.2
    )


def behavior() -> VisionBehaviorV1:
    now = datetime.now(UTC)
    return VisionBehaviorV1(
        **common(), camera_id="cam-01", track_id=1, behavior="fall",
        confidence_avg=0.8, duration_s=2.0, ts_start=now, ts_end=now,
    )  # fmt: skip


def alert() -> SecurityAlertV1:
    return SecurityAlertV1(
        **common(), rule_id="HYD-NET-0001", rule_version="1.0.0", category="auth_bruteforce",
        severity="high", src_ip="172.30.1.20", dst_ip="172.30.0.12", device_id="cam-02",
        technique="T1110", evidence_ref="eve:1",
    )  # fmt: skip


@pytest.fixture(autouse=True)
def no_heartbeat(monkeypatch: pytest.MonkeyPatch) -> None:
    """用例断言"下一帧"是什么，心跳不得插入其间。"""
    monkeypatch.setattr(ws_module, "HEARTBEAT_S", 3600)


@pytest.fixture
def client(db: tuple[ApiConfig, ApiConfig], password: str) -> Iterator[TestClient]:
    with TestClient(create_app(db[1]), base_url="https://testserver") as c:
        body = {"username": "viewer", "password": password}
        c.post("/api/auth/login", json=body, headers={"X-Request-ID": "r"})
        yield c


def publish(nats_url: str, subject: str, event: EventBase) -> None:
    async def main() -> None:
        bus = await Bus.connect(nats_url, name="test", timeout_s=2)
        try:
            await bus.publish(subject, event)
        finally:
            await bus.close()

    asyncio.run(main())


def next_frame(client: TestClient, ws: WebSocketTestSession) -> WsFrame:
    async def fallback() -> None:
        # receive_json 无超时：未转发时以哨兵帧结束等待，使用例失败而非挂起
        await asyncio.sleep(2)
        client.app.state.hub.broadcast(SENTINEL)

    pending = client.portal.start_task_soon(fallback)
    try:
        return WsFrame.model_validate(ws.receive_json())
    finally:
        pending.cancel()


@pytest.mark.parametrize(
    ("subject", "event", "channel"),
    [
        ("hyd.vision.track.v1", track(), "tracks"),
        ("hyd.vision.behavior.v1", behavior(), "alerts"),
        ("hyd.security.alert.v1", alert(), "alerts"),
    ],
)
def test_forwards_event_to_channel(
    client: TestClient, nats_url: str, subject: str, event: EventBase, channel: str
) -> None:
    with client.websocket_connect(WS_URL) as ws:
        publish(nats_url, subject, event)

        frame = next_frame(client, ws)

    assert frame.channel == channel
    assert type(event).model_validate(frame.data) == event
