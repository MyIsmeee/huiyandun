"""删除告警接口：角色、审计、推送与重启后的补推。"""

import time
import uuid
from collections.abc import Iterator
from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient
from test_containment import audited, login

from api_server.app import create_app
from api_server.cleared import WINDOW, Cleared
from api_server.config import ApiConfig
from py_contracts.api import AlertsCleared


@pytest.fixture
def client(db: tuple[ApiConfig, ApiConfig]) -> Iterator[TestClient]:
    with TestClient(create_app(db[1]), base_url="https://testserver") as c:
        yield c


def test_viewer_cannot_clear(client: TestClient, password: str) -> None:
    login(client, "viewer", password)
    body = {"event_ids": [str(uuid.uuid4())], "incident_ids": []}
    r = client.post("/api/alerts/clear", json=body, headers={"X-Request-ID": "c0"})
    assert r.status_code == 403


def test_clear_audited_broadcast_and_restored(
    client: TestClient, db: tuple[ApiConfig, ApiConfig], password: str
) -> None:
    login(client, "operator", password)
    event_id = str(uuid.uuid4())
    incident_id = f"inc-{uuid.uuid4().hex[:8]}"
    hub = client.app.state.hub  # type: ignore[attr-defined]
    listener = hub.subscribe(b"test-listener")

    body = {"event_ids": [event_id], "incident_ids": [incident_id]}
    r = client.post("/api/alerts/clear", json=body, headers={"X-Request-ID": "c1"})

    assert r.status_code == 200, r.text
    assert (r.json()["event_ids"], r.json()["incident_ids"], r.json()["actor"]) == (
        [event_id],
        [incident_id],
        "operator",
    )
    assert audited(db[1], "c1", "alerts.cleared") == [("operator", "alerts.cleared", "alerts")]
    pushed = listener.queue.get_nowait()
    assert '"channel":"cleared"' in pushed and event_id in pushed

    # 重启后从审计日志读回（后台进行），连接建立时补推
    with TestClient(create_app(db[1]), base_url="https://testserver") as again:
        restored = again.app.state.cleared  # type: ignore[attr-defined]
        for _ in range(50):
            frames = [f for f in restored.snapshot() if incident_id in f.data["incident_ids"]]
            if frames:
                break
            time.sleep(0.1)
        [frame] = frames
        assert frame.data["event_ids"] == [event_id]


def test_rejects_unknown_fields(client: TestClient, password: str) -> None:
    login(client, "operator", password)
    body = {"event_ids": [], "incident_ids": [], "all": True}
    r = client.post("/api/alerts/clear", json=body, headers={"X-Request-ID": "c2"})
    assert r.status_code == 400


def test_records_older_than_window_are_dropped() -> None:
    """超过补推窗口的删除记录不再补推，也不留在内存中。"""
    cleared = Cleared()
    for ts in (datetime.now(UTC) - WINDOW * 2, datetime.now(UTC)):
        cleared.add(
            AlertsCleared.model_validate(
                {"event_ids": [str(uuid.uuid4())], "incident_ids": [], "actor": "op", "ts": ts}
            )
        )
    assert len(cleared.snapshot()) == 1
    assert len(cleared._records) == 1
