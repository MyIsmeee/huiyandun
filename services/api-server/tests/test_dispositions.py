"""告警处置接口：角色、审计、物理告警态解除与重启后的补推。"""

import time
import uuid
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta

import httpx2
import pytest
from fastapi.testclient import TestClient
from test_containment import audited, login

from api_server import evidence
from api_server.app import create_app
from api_server.config import ApiConfig
from py_contracts.events.hyd_vision_behavior_v1_schema import VisionBehaviorV1


def fall(camera_id: str) -> VisionBehaviorV1:
    now = datetime.now(UTC).isoformat()
    return VisionBehaviorV1.model_validate(
        {
            "schema_version": "1.2.0", "event_id": str(uuid.uuid4()), "ts": now,
            "camera_id": camera_id, "track_id": 3, "behavior": "fall", "level": "confirmed",
            "confidence_avg": 0.9, "duration_s": 8, "ts_start": now, "ts_end": now,
        }
    )  # fmt: skip


@pytest.fixture
def client(db: tuple[ApiConfig, ApiConfig]) -> Iterator[TestClient]:
    with TestClient(create_app(db[1]), base_url="https://testserver") as c:
        yield c


def alerting(client: TestClient) -> tuple[str, str]:
    """让第一台摄像头进入物理告警，返回 (摄像头, 告警 event_id)。"""
    state = client.app.state  # type: ignore[attr-defined]
    camera = state.site.devices[0].id
    event = fall(camera)
    state.history.add_alert(event)
    state.devices.on_behavior(event, time.monotonic())
    assert state.devices.get(camera).state == "physical_alert"
    return camera, str(event.event_id)


def test_viewer_cannot_dispose(client: TestClient, password: str) -> None:
    _, event_id = alerting(client)
    login(client, "viewer", password)
    r = client.post(
        f"/api/alerts/{event_id}/disposition",
        json={"action": "acknowledged"},
        headers={"X-Request-ID": "d0"},
    )
    assert r.status_code == 403


def test_unknown_alert_404(client: TestClient, password: str) -> None:
    login(client, "operator", password)
    r = client.post(
        f"/api/alerts/{uuid.uuid4()}/disposition",
        json={"action": "resolved"},
        headers={"X-Request-ID": "d1"},
    )
    assert r.status_code == 404


def test_acknowledge_keeps_alert_false_positive_releases_it(
    client: TestClient, db: tuple[ApiConfig, ApiConfig], password: str
) -> None:
    camera, event_id = alerting(client)
    login(client, "operator", password)
    state = client.app.state  # type: ignore[attr-defined]

    r = client.post(
        f"/api/alerts/{event_id}/disposition",
        json={"action": "acknowledged"},
        headers={"X-Request-ID": "d2"},
    )
    assert r.status_code == 200, r.text
    assert (r.json()["action"], r.json()["actor"]) == ("acknowledged", "operator")
    assert state.devices.get(camera).state == "physical_alert"  # 已确认：告警态不变

    body = {"action": "false_positive", "note": "有人蹲下系鞋带"}
    r = client.post(
        f"/api/alerts/{event_id}/disposition", json=body, headers={"X-Request-ID": "d3"}
    )
    assert r.status_code == 200, r.text
    assert state.devices.get(camera).state == "normal"  # 误报：解除物理告警态
    assert audited(db[1], "d3", "alert.disposed") == [("operator", "alert.disposed", event_id)]

    # 重启后从审计日志读回（后台进行），连接建立时补推最近一次处置
    with TestClient(create_app(db[1]), base_url="https://testserver") as again:
        restored = again.app.state.dispositions  # type: ignore[attr-defined]
        for _ in range(50):
            frames = [f for f in restored.snapshot() if f.data["event_id"] == event_id]
            if frames:
                break
            time.sleep(0.1)
        [frame] = frames
        assert (frame.data["action"], frame.data["note"]) == ("false_positive", "有人蹲下系鞋带")


def test_rejects_unknown_action(client: TestClient, password: str) -> None:
    _, event_id = alerting(client)
    login(client, "operator", password)
    r = client.post(
        f"/api/alerts/{event_id}/disposition",
        json={"action": "ignore"},
        headers={"X-Request-ID": "d4"},
    )
    assert r.status_code == 400


def test_clip_window_covers_behavior_from_start_and_waits_for_flush() -> None:
    event = fall("cam-05")
    confirmed = event.ts
    started = event.model_copy(update={"ts_start": confirmed - timedelta(seconds=8)})
    later = confirmed + timedelta(seconds=30)
    assert evidence.clip_window(started, later) == (
        confirmed - timedelta(seconds=18),
        confirmed + timedelta(seconds=10),
    )
    # 刚确认时：只取到 2 s 前；时段已全在未来时没有可回放的录像
    assert evidence.clip_window(started, confirmed)[1] == confirmed - timedelta(seconds=2)  # type: ignore[index]
    assert evidence.clip_window(started, started.ts_start - timedelta(seconds=9)) is None


def test_alert_clip_is_fetched_through_evidence_service(client: TestClient, password: str) -> None:
    _, event_id = alerting(client)
    asked: list[httpx2.Request] = []

    def evidence_service(request: httpx2.Request) -> httpx2.Response:
        asked.append(request)
        return httpx2.Response(200, content=b"mp4")

    state = client.app.state  # type: ignore[attr-defined]
    state.evidence = httpx2.AsyncClient(
        base_url="http://evidence", transport=httpx2.MockTransport(evidence_service)
    )
    login(client, "viewer", password)
    time.sleep(2.1)  # 告警刚确认：录像要等落盘
    r = client.get(f"/api/alerts/{event_id}/clip")
    assert (r.status_code, r.headers["content-type"], r.content) == (200, "video/mp4", b"mp4")
    assert asked[0].url.path == f"/internal/clips/{state.site.devices[0].id}"
    assert client.get(f"/api/alerts/{uuid.uuid4()}/clip").status_code == 404
