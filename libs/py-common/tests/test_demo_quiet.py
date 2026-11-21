"""演示静默的判定（py_common.demo_quiet）。"""

import uuid
from datetime import UTC, datetime
from typing import Any

import pytest
from pydantic import ValidationError

from py_common.demo_quiet import QuietPreset
from py_contracts.events.hyd_security_alert_v1_schema import SecurityAlertV1
from py_contracts.events.hyd_vision_behavior_v1_schema import VisionBehaviorV1
from py_contracts.events.hyd_vision_integrity_v1_schema import VisionIntegrityV1
from py_contracts.events.hyd_vision_track_v1_schema import VisionTrackV1

PRESET = QuietPreset.model_validate(
    {
        "integrity": {
            "hide": ["occlusion", "shift", "freeze", "replay"],
            "keep": {"cam-02": ["freeze", "replay"]},
        },
        "behavior": {"hide_levels": ["suspected"], "hide_behaviors": ["still"]},
        "alerts": {"hide_unregistered": True, "keep_rules": ["HYD-WEB-0001"]},
    }
)


def common() -> dict[str, Any]:
    return {"schema_version": "1.2.0", "event_id": uuid.uuid4(), "ts": datetime.now(UTC)}


def integrity(camera: str, kind: str) -> VisionIntegrityV1:
    return VisionIntegrityV1(
        **common(), camera_id=camera, type=kind, duration_s=5.0, source="model",
        confidence=0.9, detail=None,
    )  # fmt: skip


def behavior(kind: str, level: str | None) -> VisionBehaviorV1:
    now = datetime.now(UTC)
    return VisionBehaviorV1(
        **common(), camera_id="cam-05", track_id=1, behavior=kind, level=level,
        confidence_avg=0.8, duration_s=2.0, ts_start=now, ts_end=now,
    )  # fmt: skip


def alert(rule: str, device: str | None) -> SecurityAlertV1:
    return SecurityAlertV1(
        **common(), rule_id=rule, rule_version="1.0.0", mode="enforce", category="auth_bruteforce",
        severity="high", src_ip="192.168.5.30", dst_ip="192.168.5.199", device_id=device,
        technique="T1110", evidence_ref="eve:1", source="rule", confidence=1.0, summary="x",
    )  # fmt: skip


@pytest.mark.parametrize(
    ("event", "hidden"),
    [
        (integrity("cam-05", "occlusion"), True),
        (integrity("cam-05", "replay"), True),
        (integrity("cam-02", "replay"), False),  # 靶机画面保留重放判定
        (integrity("cam-02", "shift"), True),  # 靶机画面的挪位照样静默
        (integrity("cam-05", "stream_lost"), False),  # 断流是真实状态
        (behavior("fall", "suspected"), True),
        (behavior("fight", "suspected"), True),
        (behavior("still", "confirmed"), True),
        (behavior("fall", "confirmed"), False),
        (behavior("climb", None), False),  # 1.0 没有 level，按 confirmed
        (alert("HYD-NET-0001", None), True),
        (alert("HYD-WEB-0001", None), False),
        (alert("HYD-NET-0001", "cam-02"), False),
    ],
)
def test_hides(event: Any, hidden: bool) -> None:
    assert PRESET.hides(event) is hidden


def test_default_hides_nothing() -> None:
    track = VisionTrackV1(
        **common(), camera_id="cam-05", track_id=1, object_class="person", x=1.0, y=1.0,
        uncertainty_m=0.2, heading_deg=None, speed_mps=None, bbox=[0.1, 0.2, 0.3, 0.8], keypoints=None,
    )  # fmt: skip
    empty = QuietPreset()
    for event in (
        integrity("cam-05", "occlusion"),
        behavior("fall", "suspected"),
        alert("X", None),
    ):
        assert not empty.hides(event)
    assert not PRESET.hides(track)


@pytest.mark.parametrize(
    "preset",
    [
        {"integrity": {"hide": ["stream_lost"]}},  # 断流不可静默
        {"integrity": {"keep": {"cam-02": ["stream_lost"]}}},
        {"behavior": {"hide_levels": ["maybe"]}},
        {"alerts": {"hide_unregistred": True}},  # 拼错的键报错，不静默失效
    ],
)
def test_invalid_preset_rejected(preset: dict[str, Any]) -> None:
    with pytest.raises(ValidationError):
        QuietPreset.model_validate(preset)
