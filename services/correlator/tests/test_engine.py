"""关联引擎（TK-041）：序列匹配、去重与关联事件字段。规则样本回放见 test_rule_samples。"""

import json
import logging
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest

from correlator.engine import SUPPRESS, Engine
from correlator.rules import Event, load_rules
from py_contracts.events.hyd_correlator_incident_v1_schema import CorrelatorIncidentV1
from py_contracts.events.hyd_security_alert_v1_schema import SecurityAlertV1
from py_contracts.events.hyd_vision_behavior_v1_schema import VisionBehaviorV1
from py_contracts.events.hyd_vision_integrity_v1_schema import VisionIntegrityV1

ROOT = Path(__file__).resolve().parents[3]
RULES = load_rules(ROOT / "rules/correlator")
ATTACK = json.loads((ROOT / "rules/attack/techniques.json").read_text(encoding="utf-8"))
T0 = datetime(2026, 11, 8, 2, 0, tzinfo=UTC)
ALERT, INTEGRITY, BEHAVIOR = (
    "hyd.security.alert.v1",
    "hyd.vision.integrity.v1",
    "hyd.vision.behavior.v1",
)


def alert(t: float, **fields: Any) -> SecurityAlertV1:
    return SecurityAlertV1.model_validate(
        {
            "schema_version": "1.2.0",
            "event_id": str(uuid.uuid4()),
            "ts": (T0 + timedelta(seconds=t)).isoformat(),
            "rule_id": "HYD-NET-0001",
            "rule_version": "3",
            "mode": "enforce",
            "category": "auth_bruteforce",
            "severity": "high",
            "src_ip": "172.30.0.100",
            "dst_ip": "172.30.0.12",
            "device_id": "cam-02",
            "technique": "T1110",
            "evidence_ref": "suricata:flow/1",
            "source": "rule",
            "confidence": 1.0,
            "summary": "HYD-NET-0001 RTSP authentication brute force",
        }
        | fields
    )


def integrity(t: float, **fields: Any) -> VisionIntegrityV1:
    return VisionIntegrityV1.model_validate(
        {
            "schema_version": "1.1.0",
            "event_id": str(uuid.uuid4()),
            "ts": (T0 + timedelta(seconds=t)).isoformat(),
            "camera_id": "cam-02",
            "type": "freeze",
            "duration_s": 5.0,
            "source": "rule",
            "confidence": 1.0,
            "detail": None,
        }
        | fields
    )


def feed(engine: Engine, *events: tuple[str, Event]) -> list[CorrelatorIncidentV1]:
    return [i for subject, event in events for i in engine.feed(subject, event)]


def test_incident_fields() -> None:
    first, second = alert(0), integrity(120)
    (incident,) = feed(Engine(RULES, ATTACK), (ALERT, first), (INTEGRITY, second))

    data = incident.model_dump(mode="json", exclude={"ts", "created_at"})
    assert data == {
        "schema_version": "1.2.0",
        "event_id": data["id"],
        "id": data["id"],
        "rule_id": "HYD-X-0001",
        "rule_version": "1.0.0",
        "mode": "enforce",
        "title": "摄像头疑似被入侵且画面遭篡改",
        "severity": "critical",
        "device_ids": ["cam-02"],
        "source_ip": "172.30.0.100",
        "techniques": ["T1110", "T0832"],
        "tactics": ["Credential Access", "Impact"],  # 按 ATT&CK 战术顺序
        "evidence_refs": ["suricata:flow/1", f"hyd.vision.integrity.v1/{second.event_id}"],
        "hit_path": [str(first.event_id), str(second.event_id)],
        "requires_confirmation": False,
        "status": "open",
    }


def test_incident_id_stable_for_same_hit_path() -> None:
    """重启后重放同一序列得到同一 ID，JetStream 按 event_id 去重。"""
    events = ((ALERT, alert(0)), (INTEGRITY, integrity(10)))
    (first,) = feed(Engine(RULES, ATTACK), *events)
    (second,) = feed(Engine(RULES, ATTACK), *events)
    assert first.id == second.id


def test_restored_incident_suppresses_replayed_sequence() -> None:
    """重启时先以近期关联事件恢复去重状态，重放的事件不再生成（D-067）。"""
    events = ((ALERT, alert(0)), (INTEGRITY, integrity(10)))
    (incident,) = feed(Engine(RULES, ATTACK), *events)
    restarted = Engine(RULES, ATTACK)
    restarted.restore(incident.model_copy(update={"created_at": T0 + timedelta(seconds=10)}))

    assert feed(restarted, *events) == []
    later = T0 + timedelta(seconds=10) + SUPPRESS
    assert feed(restarted, (ALERT, alert((later - T0).total_seconds() + 1))) == []


def test_behavior_event_requires_confirmation() -> None:
    """骨骼姿态判定的行为事件按模型证据处理（D-069）。"""
    rule = RULES[0].model_copy(
        update={
            "sequence": [
                RULES[0].sequence[0],
                RULES[0].sequence[0].model_copy(update={"subject": BEHAVIOR, "match": {}}),
            ]
        }
    )
    fall = VisionBehaviorV1.model_validate(
        {
            "schema_version": "1.0.0",
            "event_id": str(uuid.uuid4()),
            "ts": (T0 + timedelta(seconds=5)).isoformat(),
            "camera_id": "cam-02",
            "track_id": 3,
            "behavior": "fall",
            "confidence_avg": 0.9,
            "duration_s": 2.0,
            "ts_start": T0.isoformat(),
            "ts_end": (T0 + timedelta(seconds=5)).isoformat(),
        }
    )
    (incident,) = feed(Engine([rule], ATTACK), (ALERT, alert(0)), (BEHAVIOR, fall))
    assert incident.requires_confirmation


def test_unregistered_device_alert_ignored() -> None:
    """目标未登记为设备的告警没有关联键，不参与关联。"""
    engine = Engine(RULES, ATTACK)
    assert feed(engine, (ALERT, alert(0, device_id=None)), (INTEGRITY, integrity(10))) == []


def test_unknown_technique_logged_and_incident_still_published(
    caplog: pytest.LogCaptureFixture,
) -> None:
    rule = RULES[0].model_copy(
        update={"emit": RULES[0].emit.model_copy(update={"techniques": ["T1110", "T9999"]})}
    )
    with caplog.at_level(logging.WARNING):
        (incident,) = feed(Engine([rule], ATTACK), (ALERT, alert(0)), (INTEGRITY, integrity(10)))
    assert incident.tactics == ["Credential Access"]
    assert [r.message for r in caplog.records] == ["correlator.technique_unknown"]
