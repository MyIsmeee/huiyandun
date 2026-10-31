"""近 24 小时历史（D-077）：条数上限、执行只留最新状态、按发生先后补推、过期不补推。"""

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from api_server import history as history_module
from api_server.history import History
from py_contracts.events.hyd_correlator_incident_v1_schema import CorrelatorIncidentV1
from py_contracts.events.hyd_playbook_execution_v1_schema import PlaybookExecutionV1
from py_contracts.events.hyd_vision_behavior_v1_schema import VisionBehaviorV1


def behavior(ts: datetime) -> VisionBehaviorV1:
    return VisionBehaviorV1(
        schema_version="1.0.0", event_id=uuid.uuid4(), ts=ts, camera_id="cam-01", track_id=1,
        behavior="fall", confidence_avg=0.8, duration_s=2.0, ts_start=ts, ts_end=ts,
    )  # fmt: skip


def execution(execution_id: str, state: str, ts: datetime) -> PlaybookExecutionV1:
    fields: dict[str, Any] = {
        "schema_version": "1.1.0", "event_id": str(uuid.uuid4()), "ts": ts.isoformat(),
        "id": execution_id, "playbook_id": "isolate-attacker", "playbook_version": "1.0.0",
        "incident_id": "inc-1", "device_ids": ["cam-02"], "target": "172.30.0.100",
        "state": state, "reason": None, "ttl_s": 150, "expires_at": None, "verify_result": None,
    }  # fmt: skip
    return PlaybookExecutionV1.model_validate(fields)


def test_alerts_capped_and_ordered() -> None:
    now = datetime.now(UTC)
    history = History()
    for i in range(history_module.MAX_ALERTS + 5):
        history.add_alert(behavior(now - timedelta(seconds=1000 - i)))

    frames = history.snapshot()

    assert len(frames) == history_module.MAX_ALERTS
    stamps = [f.data["ts"] for f in frames]
    assert stamps == sorted(stamps)


def test_execution_keeps_latest_state_only() -> None:
    now = datetime.now(UTC)
    history = History()
    history.add_execution(execution("exe-1", "executing", now - timedelta(seconds=3)))
    history.add_execution(execution("exe-2", "contained", now - timedelta(seconds=2)))
    history.add_execution(execution("exe-1", "contained", now - timedelta(seconds=1)))

    frames = history.snapshot()

    assert [(f.channel, f.data["id"], f.data["state"]) for f in frames] == [
        ("executions", "exe-2", "contained"),
        ("executions", "exe-1", "contained"),
    ]


def test_older_than_window_not_replayed() -> None:
    now = datetime.now(UTC)
    history = History()
    history.add_alert(behavior(now - timedelta(hours=25)))
    history.add_alert(behavior(now - timedelta(hours=1)))

    assert len(history.snapshot()) == 1


def test_lookup_ignores_older_than_window() -> None:
    """TK-070：报告只引用近 24 小时的事件，与"已超过 24 小时为 404"一致。"""
    now = datetime.now(UTC)
    old, recent = behavior(now - timedelta(hours=25)), behavior(now - timedelta(hours=1))
    history = History()
    history.add_alert(old)
    history.add_alert(recent)

    assert history.event(old.event_id) is None
    assert history.event(recent.event_id) == recent

    incident = CorrelatorIncidentV1.model_validate(
        {
            "schema_version": "1.2.0", "event_id": str(uuid.uuid4()),
            "ts": (now - timedelta(hours=25)).isoformat(), "id": "inc-old",
            "rule_id": "HYD-X-0001", "rule_version": "1.0.0", "mode": "enforce", "title": "t",
            "severity": "critical", "device_ids": [], "source_ip": None, "techniques": [],
            "tactics": [], "evidence_refs": [], "hit_path": [], "requires_confirmation": False,
            "status": "open", "created_at": (now - timedelta(hours=25)).isoformat(),
        }
    )  # fmt: skip
    history.add_incident(incident)
    assert history.incident("inc-old") is None
