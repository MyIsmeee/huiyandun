"""设备状态的进入、续期、叠加、解除与连接补推（HYD-UIX-004 §5.2，#54）。"""

import uuid
from datetime import UTC, datetime
from pathlib import Path

import pytest

from api_server import site
from api_server.devices import CYBER_HOLD_S, PHYSICAL_HOLD_S, Devices
from py_contracts.events.hyd_security_alert_v1_schema import SecurityAlertV1
from py_contracts.events.hyd_vision_behavior_v1_schema import VisionBehaviorV1

SITE = Path(__file__).resolve().parents[3] / "demo/scenarios/site.yaml"


def behavior(camera_id: str = "cam-01") -> VisionBehaviorV1:
    now = datetime.now(UTC)
    return VisionBehaviorV1(
        schema_version="1.0.0", event_id=uuid.uuid4(), ts=now, camera_id=camera_id,
        track_id=3, behavior="fall", confidence_avg=0.8, duration_s=2.0, ts_start=now, ts_end=now,
    )  # fmt: skip


def alert(severity: str = "high", device_id: str | None = "cam-01") -> SecurityAlertV1:
    return SecurityAlertV1(
        schema_version="1.0.0", event_id=uuid.uuid4(), ts=datetime.now(UTC),
        rule_id="HYD-NET-0001", rule_version="1.0.0", mode="enforce", category="auth_bruteforce",
        severity=severity, src_ip="172.30.1.20", dst_ip="172.30.0.11", device_id=device_id,
        technique="T1110", evidence_ref="eve:1", source="rule", confidence=1.0,
        summary="HYD-NET-0001 RTSP authentication brute force",
    )  # fmt: skip


@pytest.fixture
def devices() -> Devices:
    """演示站点的两台摄像头，cam-02 改为未标定。"""
    cam1, cam2 = site.load(SITE).devices
    return Devices([cam1, cam2.model_copy(update={"state": "uncalibrated"})])


def states(devices: Devices) -> dict[str, tuple[str, str | None]]:
    frames = [f.data for f in devices.snapshot() if f.channel == "devices"]
    return {d["id"]: (d["state"], d["alert_severity"]) for d in frames}


def test_initial_state_from_site(devices: Devices) -> None:
    assert states(devices) == {"cam-01": ("normal", None), "cam-02": ("uncalibrated", None)}


def test_behavior_enters_physical_alert_and_expires(devices: Devices) -> None:
    changed = devices.on_behavior(behavior(), now=0)

    assert changed is not None and changed.state == "physical_alert"
    assert devices.expire(PHYSICAL_HOLD_S - 0.1) == []
    [restored] = devices.expire(PHYSICAL_HOLD_S)
    assert (restored.id, restored.state) == ("cam-01", "normal")


def test_repeated_behavior_extends_hold_without_push(devices: Devices) -> None:
    devices.on_behavior(behavior(), now=0)

    assert devices.on_behavior(behavior(), now=50) is None
    assert devices.expire(PHYSICAL_HOLD_S) == []
    assert [d.state for d in devices.expire(50 + PHYSICAL_HOLD_S)] == ["normal"]


def test_uncalibrated_camera_alerts_then_returns_to_uncalibrated(devices: Devices) -> None:
    """未标定摄像头只输出设备级告警（C-CV-05），解除后回到 uncalibrated。"""
    devices.on_behavior(behavior("cam-02"), now=0)

    assert states(devices)["cam-02"] == ("physical_alert", None)
    assert [d.state for d in devices.expire(PHYSICAL_HOLD_S)] == ["uncalibrated"]


def test_alert_severity_keeps_highest_and_pushes_on_raise(devices: Devices) -> None:
    first = devices.on_alert(alert("medium"), now=0)
    raised = devices.on_alert(alert("critical"), now=1)

    assert first is not None and (first.state, first.alert_severity) == ("cyber_alert", "medium")
    assert raised is not None and raised.alert_severity == "critical"
    assert devices.on_alert(alert("low"), now=2) is None
    assert states(devices)["cam-01"] == ("cyber_alert", "critical")


def test_cyber_expiry_clears_severity_and_next_round_starts_fresh(devices: Devices) -> None:
    devices.on_alert(alert("critical"), now=0)

    [restored] = devices.expire(CYBER_HOLD_S)
    assert (restored.state, restored.alert_severity) == ("normal", None)
    again = devices.on_alert(alert("low"), now=CYBER_HOLD_S + 1)
    assert again is not None and again.alert_severity == "low"


def test_severity_resets_even_before_expiry_tick(devices: Devices) -> None:
    """解除时刻与下一次计时检查之间到来的新告警，不沿用上一轮的等级。"""
    devices.on_alert(alert("critical"), now=0)

    again = devices.on_alert(alert("low"), now=CYBER_HOLD_S + 0.5)

    assert again is not None and again.alert_severity == "low"


def test_both_then_physical_expires_to_cyber(devices: Devices) -> None:
    devices.on_behavior(behavior(), now=0)
    both = devices.on_alert(alert("high"), now=1)

    assert both is not None and (both.state, both.alert_severity) == ("both", "high")
    [cyber] = devices.expire(PHYSICAL_HOLD_S)
    assert (cyber.state, cyber.alert_severity) == ("cyber_alert", "high")


def test_unregistered_targets_change_nothing(devices: Devices) -> None:
    assert devices.on_behavior(behavior("cam-99"), now=0) is None
    assert devices.on_alert(alert(device_id=None), now=0) is None
    assert devices.on_alert(alert(device_id="cam-99"), now=0) is None
    assert states(devices) == {"cam-01": ("normal", None), "cam-02": ("uncalibrated", None)}


def test_snapshot_pushes_devices_then_behaviors_in_physical_alert(devices: Devices) -> None:
    event = behavior()
    devices.on_behavior(event, now=0)
    devices.on_alert(alert(device_id="cam-02"), now=0)

    frames = devices.snapshot()

    assert [f.channel for f in frames] == ["devices", "devices", "alerts"]
    assert VisionBehaviorV1.model_validate(frames[2].data) == event
    devices.expire(PHYSICAL_HOLD_S)
    assert [f.channel for f in devices.snapshot()] == ["devices", "devices"]
