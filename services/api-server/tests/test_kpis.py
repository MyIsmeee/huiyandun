"""大屏关键指标（D-100）：四项指标的口径、较 1 小时前的变化与 GET /api/kpis。"""

import time
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from test_devices import SITE, alert, behavior, stream_lost
from test_history import execution

from api_server import site
from api_server.app import create_app
from api_server.config import ApiConfig
from api_server.devices import Devices
from api_server.history import History
from api_server.kpis import KpiTracker
from py_contracts.api import Kpi
from py_contracts.events.event_base_schema import EventBase

DAY_START = datetime(2026, 11, 3, 16, tzinfo=UTC)  # 北京时间 11 月 4 日 0 点
NOW = DAY_START + timedelta(hours=12)
HOUR = timedelta(hours=1)


@pytest.fixture
def devices() -> Devices:
    return Devices(site.load(SITE).devices)


@pytest.fixture
def history() -> History:
    return History()


def tracker(devices: Devices, history: History, started: datetime = NOW - 2 * HOUR) -> KpiTracker:
    return KpiTracker(devices, history, started)


def test_online_devices_excludes_offline_and_compares_hour_ago(
    devices: Devices, history: History
) -> None:
    kpis = tracker(devices, history)
    devices.on_stream_lost(stream_lost("cam-01"), time.monotonic())
    kpis.tick(NOW - timedelta(minutes=30))

    assert kpis.read(DAY_START, NOW).online_devices == Kpi(value=1, delta=-1)


def test_online_devices_counts_stream_lost_under_containment(
    devices: Devices, history: History
) -> None:
    """已处置在画面上覆盖离线（04 §5.2），在线台数仍按断流计。"""
    kpis = tracker(devices, history)
    now = time.monotonic()
    devices.on_execution(execution("exe-1", "contained", NOW), now)  # 处置 cam-02
    devices.on_stream_lost(stream_lost("cam-02"), now)

    assert devices.get("cam-02").state == "contained"
    assert kpis.read(DAY_START, NOW).online_devices.value == 1


def test_online_devices_no_delta_within_first_hour(devices: Devices, history: History) -> None:
    kpis = tracker(devices, history, started=NOW - timedelta(minutes=10))

    assert kpis.read(DAY_START, NOW).online_devices == Kpi(value=2, delta=None)


def at[T: EventBase](event: T, ts: datetime) -> T:
    return event.model_copy(update={"ts": ts})


def test_active_alerts_counted_within_hold(devices: Devices, history: History) -> None:
    for event in (
        at(alert(), NOW - timedelta(seconds=299)),  # 网络告警保持 5 分钟：计入
        at(alert(), NOW - timedelta(seconds=301)),
        at(behavior(), NOW - timedelta(seconds=59)),  # 行为事件保持 1 分钟：计入
        at(behavior(), NOW - timedelta(seconds=61)),
        at(alert(), NOW - HOUR - timedelta(seconds=10)),  # 1 小时前仍在保持期
    ):
        history.add_alert(event)

    assert tracker(devices, history).read(DAY_START, NOW).active_alerts == Kpi(value=2, delta=1)


def contained(kpis: KpiTracker, incident_id: str, state: str, ts: datetime) -> None:
    event = execution(f"exe-{incident_id}-{state}", state, ts)
    kpis.on_execution(event.model_copy(update={"incident_id": incident_id}))


def test_contained_today_counts_incidents_once(devices: Devices, history: History) -> None:
    kpis = tracker(devices, history)
    contained(kpis, "inc-1", "contained", NOW - 2 * HOUR)
    contained(kpis, "inc-1", "rolled_back", NOW - 2 * HOUR + timedelta(minutes=3))  # 回滚仍计入
    contained(kpis, "inc-2", "notify_only", NOW - timedelta(minutes=5))  # 只通知不计
    contained(kpis, "inc-3", "contained", NOW - 3 * HOUR)
    kpis.on_execution(  # 同一关联事件的第二个执行
        execution("exe-inc-3-again", "contained", NOW - timedelta(minutes=20)).model_copy(
            update={"incident_id": "inc-3"}
        )
    )
    contained(kpis, "inc-4", "contained", DAY_START - HOUR)  # 昨天
    contained(kpis, "inc-5", "contained", NOW - timedelta(minutes=10))

    assert kpis.read(DAY_START, NOW).contained_today == Kpi(value=3, delta=1)


def test_contained_hour_ago_counts_previous_day(devices: Devices, history: History) -> None:
    """0 点后 1 小时内，1 小时前的值是昨天截至那时的累计。"""
    now = DAY_START + timedelta(minutes=30)
    kpis = tracker(devices, history, started=now - 2 * HOUR)
    contained(kpis, "inc-1", "contained", DAY_START - 2 * HOUR)
    contained(kpis, "inc-2", "contained", DAY_START + timedelta(minutes=10))

    assert kpis.read(DAY_START, now).contained_today == Kpi(value=1, delta=0)


def live(kpis: KpiTracker, latency_ms: int, received: datetime) -> None:
    kpis.on_live_alert(at(alert(), received - timedelta(milliseconds=latency_ms)), received)


def test_detect_p95_over_last_hour(devices: Devices, history: History) -> None:
    kpis = tracker(devices, history)
    for i in range(1, 21):  # 10～200 ms，95 分位按最近秩取第 19 个
        live(kpis, i * 10, NOW - timedelta(minutes=i))
    live(kpis, 500, NOW - 90 * timedelta(minutes=1))  # 前一小时
    live(kpis, 9000, NOW - 3 * HOUR)  # 两小时以前，不参与

    assert kpis.read(DAY_START, NOW).detect_p95_ms == Kpi(value=190, delta=-310)


def test_detect_p95_without_samples(devices: Devices, history: History) -> None:
    kpis = tracker(devices, history)
    live(kpis, 300, NOW - 90 * timedelta(minutes=1))

    assert kpis.read(DAY_START, NOW).detect_p95_ms == Kpi(value=None, delta=None)


def test_detect_p95_excludes_behavior_model(devices: Devices, history: History) -> None:
    """设备行为模型要连续两个 30 s 窗口偏离才告警，时延是设计使然，不计入（D-100）。"""
    kpis = tracker(devices, history)
    live(kpis, 120, NOW - timedelta(minutes=2))
    received = NOW - timedelta(minutes=1)
    model = alert().model_copy(update={"source": "model", "rule_id": "behavior-model"})
    kpis.on_live_alert(at(model, received - timedelta(seconds=38)), received)

    assert kpis.read(DAY_START, NOW).detect_p95_ms.value == 120


@pytest.fixture
def client(db: tuple[ApiConfig, ApiConfig], password: str) -> Iterator[TestClient]:
    with TestClient(create_app(db[1]), base_url="https://testserver") as c:
        yield c


def test_get_kpis_requires_login(client: TestClient) -> None:
    assert client.get("/api/kpis", params={"day_start": DAY_START.isoformat()}).status_code == 401


def test_viewer_gets_kpis(client: TestClient, password: str) -> None:
    body = {"username": "viewer", "password": password}
    client.post("/api/auth/login", json=body, headers={"X-Request-ID": "req-kpis"})

    res = client.get("/api/kpis", params={"day_start": DAY_START.isoformat()})

    assert res.status_code == 200
    assert res.json()["online_devices"] == {"value": 2, "delta": None}
    assert set(res.json()) == {
        "online_devices",
        "active_alerts",
        "contained_today",
        "detect_p95_ms",
    }


@pytest.mark.parametrize("day_start", [None, "2026-11-04T00:00:00", "not-a-time"])
def test_day_start_must_carry_timezone(
    client: TestClient, password: str, day_start: str | None
) -> None:
    body = {"username": "viewer", "password": password}
    client.post("/api/auth/login", json=body, headers={"X-Request-ID": "req-kpis-bad"})

    params = {} if day_start is None else {"day_start": day_start}
    assert client.get("/api/kpis", params=params).status_code == 400
