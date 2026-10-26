"""事件契约：公共字段、取值约束与向后兼容（HYD-PLAN-007 §2、C-BE-02）。"""

from pathlib import Path
from typing import Any

import pytest
from py_contracts.events.hyd_vision_behavior_v1_schema import VisionBehaviorV1
from py_contracts.events.hyd_vision_integrity_v1_schema import VisionIntegrityV1
from py_contracts.events.hyd_vision_track_v1_schema import VisionTrackV1
from pydantic import BaseModel, ValidationError

EVENTS_DIR = Path(__file__).resolve().parents[1] / "contracts" / "events"
TS = "2026-10-26T08:00:00.000Z"
BASE = {"schema_version": "1.0.0", "event_id": "8d2f3c1e-4b5a-4c6d-9e7f-0a1b2c3d4e5f", "ts": TS}

SAMPLES: dict[str, tuple[type[BaseModel], dict[str, Any]]] = {
    "hyd.vision.track.v1": (
        VisionTrackV1,
        {"camera_id": "cam-01", "track_id": 3, "x": 4.0, "y": 6.0, "uncertainty_m": 0.5},
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
        {"camera_id": "cam-02", "type": "freeze", "duration_s": 12.0},
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
    ],
)
def test_rejects_invalid_value(subject: str, field: str, value: Any) -> None:
    with pytest.raises(ValidationError):
        validate(subject, event(subject, **{field: value}))
