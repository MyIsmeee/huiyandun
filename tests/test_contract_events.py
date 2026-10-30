"""事件契约：公共字段、取值约束与向后兼容（HYD-PLAN-007 §2、C-BE-02）。"""

from pathlib import Path
from typing import Any

import pytest
from pydantic import BaseModel, ValidationError

from py_contracts.events.hyd_ai_investigation_v1_schema import AiInvestigationV1
from py_contracts.events.hyd_correlator_confirmation_v1_schema import CorrelatorConfirmationV1
from py_contracts.events.hyd_correlator_incident_v1_schema import CorrelatorIncidentV1
from py_contracts.events.hyd_playbook_execution_v1_schema import PlaybookExecutionV1
from py_contracts.events.hyd_playbook_rollback_v1_schema import PlaybookRollbackV1
from py_contracts.events.hyd_security_alert_v1_schema import SecurityAlertV1
from py_contracts.events.hyd_vision_behavior_v1_schema import VisionBehaviorV1
from py_contracts.events.hyd_vision_integrity_v1_schema import VisionIntegrityV1
from py_contracts.events.hyd_vision_scene_v1_schema import VisionSceneV1
from py_contracts.events.hyd_vision_track_v1_schema import VisionTrackV1
from py_contracts.events.incident_schema import Incident
from py_contracts.events.playbook_execution_schema import PlaybookExecution

EVENTS_DIR = Path(__file__).resolve().parents[1] / "contracts" / "events"
TS = "2026-10-26T08:00:00.000Z"
BASE = {"schema_version": "1.0.0", "event_id": "8d2f3c1e-4b5a-4c6d-9e7f-0a1b2c3d4e5f", "ts": TS}
HIT = "1f0e2d3c-4b5a-4968-8776-655443322110"

SAMPLES: dict[str, tuple[type[BaseModel], dict[str, Any]]] = {
    "hyd.vision.track.v1": (
        VisionTrackV1,
        {
            "camera_id": "cam-01",
            "track_id": 3,
            "object_class": "person",
            "x": 4.0,
            "y": 6.0,
            "uncertainty_m": 0.5,
            "heading_deg": 90.0,
            "speed_mps": 1.2,
            "bbox": [0.1, 0.2, 0.3, 0.8],
            "keypoints": [[0.2, 0.3, 0.9]] * 17,
        },
    ),
    "hyd.vision.scene.v1": (
        VisionSceneV1,
        {
            "camera_id": "cam-01",
            "surfaces": [{"class": "road", "polygon": [[0.0, 0.0], [4.0, 0.0], [4.0, 9.0]]}],
            "walls": [{"class": "building", "line": [[5.0, 0.0], [5.0, 9.0]], "height_m": 6.0}],
            "objects": [
                {
                    "class": "street_furniture",
                    "polygon": [[1.0, 1.0], [1.5, 1.0], [1.5, 1.4]],
                    "height_m": 0.8,
                }
            ],
            "trees": [{"x": 6.0, "y": 3.0, "height_m": 5.0}],
            "markings": [{"class": "lane", "polygon": [[2.0, 1.0], [2.1, 1.0], [2.1, 4.0]]}],
        },
    ),
    "hyd.vision.behavior.v1": (
        VisionBehaviorV1,
        {
            "camera_id": "cam-01",
            "track_id": 3,
            "behavior": "climb",
            "confidence_avg": 0.82,
            "duration_s": 2.5,
            "ts_start": TS,
            "ts_end": TS,
        },
    ),
    "hyd.vision.integrity.v1": (
        VisionIntegrityV1,
        {
            "camera_id": "cam-02",
            "type": "replay",
            "duration_s": 12.0,
            "source": "model",
            "confidence": 0.97,
            "detail": "与 01:12:40 的片段相同",
        },
    ),
    "hyd.security.alert.v1": (
        SecurityAlertV1,
        {
            "rule_id": "2024897",
            "rule_version": "3",
            "mode": "monitor",
            "category": "auth_bruteforce",
            "severity": "high",
            "src_ip": "172.30.0.66",
            "dst_ip": "172.30.0.12",
            "device_id": "cam-02",
            "technique": "T1110",
            "evidence_ref": "suricata:eve:1024",
            "source": "rule",
            "confidence": 1.0,
            "summary": "60 s 内 5 次 RTSP 认证失败",
        },
    ),
    "hyd.correlator.incident.v1": (
        CorrelatorIncidentV1,
        {
            "id": "inc-0001",
            "rule_id": "HYD-X-0001",
            "rule_version": "1.0.0",
            "mode": "enforce",
            "title": "摄像头疑似被入侵且画面遭篡改",
            "severity": "critical",
            "device_ids": ["cam-02"],
            "source_ip": "172.30.0.66",
            "techniques": ["T1110", "T0832"],
            "tactics": ["Credential Access"],
            "evidence_refs": ["suricata:eve:1024"],
            "hit_path": [HIT],
            "requires_confirmation": True,
            "status": "open",
            "created_at": TS,
        },
    ),
    "hyd.playbook.execution.v1": (
        PlaybookExecutionV1,
        {
            "id": "exe-0001",
            "playbook_id": "isolate-attacker",
            "playbook_version": "1.0.0",
            "incident_id": "inc-0001",
            "device_ids": ["cam-02"],
            "target": "172.30.0.66",
            "state": "contained",
            "reason": None,
            "ttl_s": 180,
            "expires_at": TS,
            "verify_result": {"passed": True, "reason": None},
        },
    ),
    "hyd.ai.investigation.v1": (
        AiInvestigationV1,
        {
            "incident_id": "inc-0001",
            "seq": 3,
            "kind": "verdict",
            "step": None,
            "verdict": {
                "is_attack": True,
                "confidence": 0.92,
                "techniques": ["T1110", "T0832"],
                "narrative": "172.30.0.66 在 60 s 内 37 次认证失败后，cam-02 画面被替换为循环片段。",
                "recommendation": "隔离 172.30.0.66",
                "unverified": [],
            },
            "error": None,
            "provider": {"name": "DeepSeek", "location": "public"},
        },
    ),
    "hyd.correlator.confirmation.v1": (
        CorrelatorConfirmationV1,
        {"incident_id": "inc-0001", "actor": "operator1", "request_id": "req-1"},
    ),
    "hyd.playbook.rollback.v1": (
        PlaybookRollbackV1,
        {"execution_id": "exe-0001", "actor": "operator1", "request_id": "req-2"},
    ),
}


def event(subject: str, **changes: Any) -> dict[str, Any]:
    return BASE | SAMPLES[subject][1] | changes


def validate(subject: str, data: dict[str, Any]) -> BaseModel:
    return SAMPLES[subject][0].model_validate(data)


def test_every_event_schema_has_sample() -> None:
    subjects = {p.name.removesuffix(".schema.json") for p in EVENTS_DIR.glob("hyd.*.schema.json")}

    assert subjects == SAMPLES.keys()


@pytest.mark.parametrize("subject", SAMPLES)
def test_accepts_valid_event(subject: str) -> None:
    validate(subject, event(subject))


@pytest.mark.parametrize("field", ["schema_version", "event_id", "ts"])
@pytest.mark.parametrize("subject", SAMPLES)
def test_requires_common_field(subject: str, field: str) -> None:
    data = event(subject)
    del data[field]

    with pytest.raises(ValidationError):
        validate(subject, data)


@pytest.mark.parametrize("version", ["2.0.0", "1.0", "v1.0.0"])
def test_rejects_schema_version_of_other_major(version: str) -> None:
    with pytest.raises(ValidationError):
        validate("hyd.vision.track.v1", event("hyd.vision.track.v1", schema_version=version))


def test_rejects_naive_timestamp() -> None:
    with pytest.raises(ValidationError):
        validate("hyd.vision.track.v1", event("hyd.vision.track.v1", ts="2026-10-26T08:00:00"))


@pytest.mark.parametrize(
    ("subject", "field"),
    [
        ("hyd.vision.track.v1", "ts"),
        ("hyd.vision.behavior.v1", "ts_start"),
        ("hyd.vision.behavior.v1", "ts_end"),
        ("hyd.correlator.incident.v1", "created_at"),
        ("hyd.playbook.execution.v1", "expires_at"),
    ],
)
def test_rejects_non_utc_timestamp(subject: str, field: str) -> None:
    with pytest.raises(ValidationError):
        validate(subject, event(subject, **{field: "2026-10-26T16:00:00.000+08:00"}))


def test_accepts_utc_offset_form() -> None:
    validate(
        "hyd.vision.track.v1", event("hyd.vision.track.v1", ts="2026-10-26T08:00:00.000+00:00")
    )


@pytest.mark.parametrize("value", [float("inf"), float("-inf"), float("nan")])
@pytest.mark.parametrize("field", ["x", "y", "uncertainty_m"])
def test_rejects_non_finite_number(field: str, value: float) -> None:
    with pytest.raises(ValidationError):
        validate("hyd.vision.track.v1", event("hyd.vision.track.v1", **{field: value}))


def test_ignores_unknown_field_from_newer_minor() -> None:
    validate("hyd.vision.track.v1", event("hyd.vision.track.v1", added_in_1_1="x"))


@pytest.mark.parametrize(
    ("subject", "field", "value"),
    [
        ("hyd.vision.track.v1", "uncertainty_m", -0.1),
        ("hyd.vision.behavior.v1", "behavior", "run"),
        ("hyd.vision.behavior.v1", "confidence_avg", 1.5),
        ("hyd.vision.integrity.v1", "type", "blur"),
        ("hyd.security.alert.v1", "severity", "urgent"),
        ("hyd.security.alert.v1", "src_ip", "999.0.0.1"),
        ("hyd.security.alert.v1", "technique", "X1110"),
        ("hyd.correlator.incident.v1", "status", "done"),
        ("hyd.correlator.incident.v1", "techniques", ["Brute Force"]),
        ("hyd.correlator.incident.v1", "hit_path", ["not-a-uuid"]),
        ("hyd.playbook.execution.v1", "state", "blocked"),
        ("hyd.playbook.execution.v1", "ttl_s", 0),
        ("hyd.playbook.execution.v1", "ttl_s", 86401),
        ("hyd.vision.track.v1", "object_class", "dog"),
        ("hyd.vision.track.v1", "heading_deg", 360.0),
        ("hyd.vision.track.v1", "speed_mps", -1.0),
        ("hyd.vision.track.v1", "bbox", [0.1, 0.2, 1.3, 0.8]),
        ("hyd.vision.track.v1", "bbox", [0.1, 0.2, 0.3]),
        ("hyd.vision.track.v1", "keypoints", [[0.2, 0.3, 0.9]] * 16),
        ("hyd.vision.integrity.v1", "source", "llm"),
        ("hyd.vision.integrity.v1", "confidence", 1.2),
        ("hyd.security.alert.v1", "source", "llm"),
        ("hyd.security.alert.v1", "confidence", -0.1),
        ("hyd.ai.investigation.v1", "kind", "thinking"),
        ("hyd.ai.investigation.v1", "seq", -1),
        ("hyd.ai.investigation.v1", "provider", {"name": "x", "location": "cloud"}),
        (
            "hyd.vision.scene.v1",
            "surfaces",
            [{"class": "sky", "polygon": [[0, 0], [1, 0], [1, 1]]}],
        ),
        ("hyd.vision.scene.v1", "surfaces", [{"class": "road", "polygon": [[0, 0], [1, 0]]}]),
        ("hyd.vision.scene.v1", "walls", [{"class": "wall", "line": [[0, 0, 1]], "height_m": 2.8}]),
        (
            "hyd.vision.scene.v1",
            "walls",
            [{"class": "wall", "line": [[0, 0], [1, 0]], "height_m": 0}],
        ),
        ("hyd.vision.scene.v1", "trees", [{"x": 1.0, "y": 2.0}]),
    ],
)
def test_rejects_invalid_value(subject: str, field: str, value: Any) -> None:
    with pytest.raises(ValidationError):
        validate(subject, event(subject, **{field: value}))


@pytest.mark.parametrize(
    ("subject", "field"),
    [
        ("hyd.security.alert.v1", "device_id"),
        ("hyd.correlator.incident.v1", "source_ip"),
        ("hyd.playbook.execution.v1", "expires_at"),
        ("hyd.playbook.execution.v1", "verify_result"),
        ("hyd.playbook.execution.v1", "reason"),
        ("hyd.vision.track.v1", "heading_deg"),
        ("hyd.vision.track.v1", "speed_mps"),
        ("hyd.vision.track.v1", "keypoints"),
        ("hyd.vision.integrity.v1", "detail"),
        ("hyd.ai.investigation.v1", "step"),
        ("hyd.ai.investigation.v1", "verdict"),
        ("hyd.ai.investigation.v1", "error"),
        ("hyd.ai.investigation.v1", "provider"),
    ],
)
def test_nullable_field_is_required_but_accepts_null(subject: str, field: str) -> None:
    validate(subject, event(subject, **{field: None}))
    data = event(subject)
    del data[field]

    with pytest.raises(ValidationError):
        validate(subject, data)


@pytest.mark.parametrize(
    ("entity", "subject"),
    [(Incident, "hyd.correlator.incident.v1"), (PlaybookExecution, "hyd.playbook.execution.v1")],
)
def test_entity_validates_without_event_envelope(entity: type[BaseModel], subject: str) -> None:
    fields = SAMPLES[subject][1]

    assert entity.model_validate(fields).model_dump(mode="json").keys() == fields.keys()


def test_dump_uses_contract_field_names() -> None:
    """字段名为 Python 关键字（class）时生成代码以别名 class_ 访问；序列化须输出契约字段名。"""
    data = validate("hyd.vision.scene.v1", event("hyd.vision.scene.v1")).model_dump(mode="json")

    assert data["surfaces"][0]["class"] == "road"
    assert "class_" not in data["surfaces"][0]
