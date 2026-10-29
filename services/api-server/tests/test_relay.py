"""NATS 事件转发到 WS /ws 各频道，设备状态变化推送与连接补推（#54）。"""

import asyncio
import uuid
from collections.abc import Callable, Iterator
from contextlib import AbstractContextManager
from datetime import UTC, datetime
from typing import Any

import pytest
from fastapi.testclient import TestClient
from starlette.testclient import WebSocketTestSession

from api_server import devices as devices_module
from api_server import relay
from api_server import ws as ws_module
from api_server.app import create_app
from api_server.config import ApiConfig
from py_common.bus import Bus
from py_contracts.api import Device, WsFrame
from py_contracts.events.event_base_schema import EventBase
from py_contracts.events.hyd_security_alert_v1_schema import SecurityAlertV1
from py_contracts.events.hyd_vision_behavior_v1_schema import VisionBehaviorV1
from py_contracts.events.hyd_vision_scene_v1_schema import VisionSceneV1
from py_contracts.events.hyd_vision_track_v1_schema import VisionTrackV1

WS_URL = "wss://testserver/ws"
SENTINEL = WsFrame(channel="system", data={"type": "sentinel"})
TRACK, BEHAVIOR, ALERT = "hyd.vision.track.v1", "hyd.vision.behavior.v1", "hyd.security.alert.v1"
SCENE = "hyd.vision.scene.v1"
type Connect = Callable[[], AbstractContextManager[WebSocketTestSession]]


def common() -> dict[str, Any]:
    return {"schema_version": "1.0.0", "event_id": uuid.uuid4(), "ts": datetime.now(UTC)}


def track() -> VisionTrackV1:
    return VisionTrackV1(
        **common(), camera_id="cam-01", track_id=1, object_class="person", x=4.0, y=6.0,
        uncertainty_m=0.2, heading_deg=None, speed_mps=None, bbox=[0.1, 0.2, 0.3, 0.8],
        keypoints=None,
    )  # fmt: skip


def behavior() -> VisionBehaviorV1:
    now = datetime.now(UTC)
    return VisionBehaviorV1(
        **common(), camera_id="cam-01", track_id=1, behavior="fall",
        confidence_avg=0.8, duration_s=2.0, ts_start=now, ts_end=now,
    )  # fmt: skip


def scene(camera_id: str = "cam-01", surface: str = "road") -> VisionSceneV1:
    polygon = [[0.0, 0.0], [4.0, 0.0], [4.0, 9.0]]
    return VisionSceneV1.model_validate(
        common()
        | {
            "camera_id": camera_id,
            "surfaces": [{"class": surface, "polygon": polygon}],
            "walls": [],
            "objects": [],
            "trees": [],
            "markings": [],
        }
    )


def alert() -> SecurityAlertV1:
    return SecurityAlertV1(
        **common(), rule_id="HYD-NET-0001", rule_version="1.0.0", category="auth_bruteforce",
        severity="high", src_ip="172.30.1.20", dst_ip="172.30.0.12", device_id="cam-02",
        technique="T1110", evidence_ref="eve:1", source="rule", confidence=1.0,
        summary="HYD-NET-0001 RTSP authentication brute force",
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
        (TRACK, track(), "tracks"),
        (BEHAVIOR, behavior(), "alerts"),
        (ALERT, alert(), "alerts"),
        (SCENE, scene(), "scene"),
    ],
)
def test_forwards_event_to_channel(
    client: TestClient,
    ws_connect: Connect,
    nats_url: str,
    subject: str,
    event: EventBase,
    channel: str,
) -> None:
    with ws_connect() as ws:
        publish(nats_url, subject, event)

        frame = next_frame(client, ws)

    assert frame.channel == channel
    assert type(event).model_validate(frame.data) == event


def device_state(frame: WsFrame) -> tuple[str, str, str, str | None]:
    device = Device.model_validate(frame.data)
    return frame.channel, device.id, device.state, device.alert_severity


def test_behavior_and_alert_push_device_after_event(
    client: TestClient, ws_connect: Connect, nats_url: str
) -> None:
    """先推事件、再推设备：设备变色时事件卡内容已就绪。"""
    with ws_connect() as ws:
        publish(nats_url, BEHAVIOR, behavior())
        assert next_frame(client, ws).channel == "alerts"
        assert device_state(next_frame(client, ws)) == ("devices", "cam-01", "physical_alert", None)

        publish(nats_url, ALERT, alert())
        assert next_frame(client, ws).channel == "alerts"
        assert device_state(next_frame(client, ws)) == ("devices", "cam-02", "cyber_alert", "high")


def test_new_connection_receives_current_state_first(
    client: TestClient, ws_connect: Connect, nats_url: str
) -> None:
    event = behavior()
    with ws_connect() as ws:
        publish(nats_url, BEHAVIOR, event)
        next_frame(client, ws)
        next_frame(client, ws)  # 设备状态已更新

    with client.websocket_connect(WS_URL) as ws:
        frames = [next_frame(client, ws) for _ in range(3)]

    assert device_state(frames[0]) == ("devices", "cam-01", "physical_alert", None)
    assert device_state(frames[1]) == ("devices", "cam-02", "normal", None)
    assert frames[2].channel == "alerts"
    assert VisionBehaviorV1.model_validate(frames[2].data) == event


@pytest.fixture
def short_hold(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(devices_module, "PHYSICAL_HOLD_S", 0.2)
    monkeypatch.setattr(relay, "EXPIRE_TICK_S", 0.05)


def test_expired_alert_pushes_restored_device(
    short_hold: None, client: TestClient, ws_connect: Connect, nats_url: str
) -> None:
    with ws_connect() as ws:
        publish(nats_url, BEHAVIOR, behavior())
        next_frame(client, ws)
        next_frame(client, ws)

        assert device_state(next_frame(client, ws)) == ("devices", "cam-01", "normal", None)


def test_new_connection_receives_latest_scene_of_each_camera(
    client: TestClient, ws_connect: Connect, nats_url: str
) -> None:
    """连接建立时先补推设备，再补推各摄像头最新一帧场景（HYD-PLAN-007 §3）。"""
    latest = scene("cam-01", "grass")
    with ws_connect() as ws:
        for event in (scene("cam-01", "road"), scene("cam-02", "floor"), latest):
            publish(nats_url, SCENE, event)
            next_frame(client, ws)

    with client.websocket_connect(WS_URL) as ws:
        frames = [next_frame(client, ws) for _ in range(4)]

    assert [f.channel for f in frames] == ["devices", "devices", "scene", "scene"]
    scenes = {s.camera_id: s for s in (VisionSceneV1.model_validate(f.data) for f in frames[2:])}
    assert scenes["cam-01"] == latest
    assert scenes["cam-02"].surfaces[0].class_ == "floor"
