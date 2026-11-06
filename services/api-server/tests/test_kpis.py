"""大屏关键指标（D-100、D-106）：四项指标的口径、变化量与 GET /api/kpis。"""

import time
import uuid
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
from py_contracts.events.hyd_correlator_incident_v1_schema import CorrelatorIncidentV1

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


def incident(
    incident_id: str, hit_path: list[uuid.UUID], created_at: datetime
) -> CorrelatorIncidentV1:
    return CorrelatorIncidentV1.model_validate(
        {
            "schema_version": "1.2.0", "event_id": str(uuid.uuid4()), "ts": created_at.isoformat(),
            "id": incident_id, "rule_id": "HYD-X-0001", "rule_version": "1.0.0", "mode": "enforce",
            "title": "摄像头疑似被入侵且画面遭篡改", "severity": "critical", "device_ids": ["cam-02"],
            "source_ip": "172.30.0.100", "techniques": ["T1110"], "tactics": ["Credential Access"],
            "evidence_refs": [], "hit_path": [str(h) for h in hit_path],
            "requires_confirmation": False, "status": "open", "created_at": created_at.isoformat(),
        }
    )  # fmt: skip


def test_last_contain_from_first_hit_to_verified(devices: Devices, history: History) -> None:
    """从命中路径中最早的事件（首条爆破告警）到处置通过校验；与上一次处置相比（D-106）。
    历史只保留近 24 小时，事件时刻按真实时钟取。"""
    t0 = datetime.now(UTC) - timedelta(minutes=30)
    first, later = at(alert(), t0), at(alert(), t0 + timedelta(seconds=20))
    history.add_alert(first)
    history.add_alert(later)
    history.add_incident(incident("inc-1", [later.event_id, first.event_id], t0))
    kpis = tracker(devices, history)
    contained(kpis, "inc-1", "contained", t0 + timedelta(seconds=31.5))

    assert kpis.read(DAY_START, NOW).last_contain_ms == Kpi(value=31500, delta=None)

    t1 = t0 + timedelta(minutes=10)
    hit = at(alert(), t1)
    history.add_alert(hit)
    history.add_incident(incident("inc-2", [hit.event_id], t1 + timedelta(seconds=5)))
    contained(kpis, "inc-2", "contained", t1 + timedelta(seconds=12))
    contained(kpis, "inc-2", "contained", t1 + timedelta(seconds=40))  # 同一事件只计首次

    assert kpis.read(DAY_START, NOW).last_contain_ms == Kpi(value=12000, delta=-19500)

    # 部分命中事件已不在历史中（如首条爆破告警被大量告警挤出）：不计，不拿余下的事件或生成时刻顶替
    t2 = t1 + timedelta(minutes=10)
    late = at(alert(), t2)
    history.add_alert(late)
    history.add_incident(incident("inc-3", [uuid.uuid4(), late.event_id], t2))
    contained(kpis, "inc-3", "contained", t2 + timedelta(seconds=1))

    assert kpis.read(DAY_START, NOW).last_contain_ms == Kpi(value=12000, delta=-19500)


def test_last_contain_when_execution_replayed_before_incident(
    devices: Devices, history: History
) -> None:
    """启动重放时处置执行可能先于关联事件到达：读取时再查。"""
    t0 = datetime.now(UTC) - timedelta(minutes=5)
    kpis = tracker(devices, history)
    contained(kpis, "inc-1", "contained", t0 + timedelta(seconds=9))
    hit = at(alert(), t0)
    history.add_alert(hit)
    history.add_incident(incident("inc-1", [hit.event_id], t0 + timedelta(seconds=3)))

    assert kpis.read(DAY_START, NOW).last_contain_ms == Kpi(value=9000, delta=None)


def test_last_contain_without_containment(devices: Devices, history: History) -> None:
    kpis = tracker(devices, history)
    contained(kpis, "inc-x", "contained", NOW)  # 关联事件不在历史中：不计用时

    assert kpis.read(DAY_START, NOW).last_contain_ms == Kpi(value=None, delta=None)


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
        "last_contain_ms",
    }


@pytest.mark.parametrize("day_start", [None, "2026-11-04T00:00:00", "not-a-time"])
def test_day_start_must_carry_timezone(
    client: TestClient, password: str, day_start: str | None
) -> None:
    body = {"username": "viewer", "password": password}
    client.post("/api/auth/login", json=body, headers={"X-Request-ID": "req-kpis-bad"})

    params = {} if day_start is None else {"day_start": day_start}
    assert client.get("/api/kpis", params=params).status_code == 400
