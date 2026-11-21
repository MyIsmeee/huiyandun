"""安装参数自检的最新结果：只给未标定的摄像头，过期与改参数后不再给出。"""

import uuid
from datetime import UTC, datetime

from api_server.pose_checks import STALE_S, PoseChecks
from py_contracts.events.hyd_vision_pose_check_v1_schema import VisionPoseCheckV1


def check(camera_id: str = "cam-03", status: str = "suspect") -> VisionPoseCheckV1:
    return VisionPoseCheckV1.model_validate({
        "schema_version": "1.0.0", "event_id": str(uuid.uuid4()), "ts": datetime.now(UTC).isoformat(),
        "camera_id": camera_id, "status": status, "samples": 24, "person_height_m": 4.9,
        "speed_p95_mps": 12.5, "suggested_height_m": 1.0, "suggested_pitch_deg": -8.0,
        "reasons": ["按当前参数推算行人身高约 4.9 m"],
    })  # fmt: skip


def test_latest_per_camera_without_envelope() -> None:
    checks = PoseChecks()
    checks.on_check(check(status="insufficient"), now=0)
    checks.on_check(check(), now=10)

    got = checks.get("cam-03", calibration_points=0, now=10)
    assert got is not None
    assert got.model_dump(mode="json")["status"] == "suspect"
    assert got.model_dump(mode="json")["suggested_height_m"] == 1.0
    assert "event_id" not in got.model_dump()
    assert checks.get("cam-04", calibration_points=0, now=10) is None


def test_calibrated_camera_has_no_check() -> None:
    checks = PoseChecks()
    checks.on_check(check(), now=0)

    assert checks.get("cam-03", calibration_points=4, now=0) is None


def test_stale_and_forgotten_checks_dropped() -> None:
    checks = PoseChecks()
    checks.on_check(check(), now=0)
    assert checks.get("cam-03", 0, now=STALE_S + 1) is None

    checks.on_check(check(), now=0)
    checks.forget("cam-03")
    assert checks.get("cam-03", 0, now=0) is None
