"""安装参数自检：由站立行人推算安装高度与俯角（D-102 估算映射的兜底检查）。"""

import math

import numpy as np
import pytest

from vision_engine.pose_check import (
    MIN_SAMPLES,
    PoseChecker,
    shoulder_heights,
    standing,
)

SIZE = (1920, 1080)
HFOV = 90.0


def project(points: np.ndarray, height: float, pitch: float) -> np.ndarray:
    """场景点 (N, 3)（z 向上，摄像头在原点上方 height、朝向 +x）→ 像素，与 from_pose 同一针孔模型。"""
    width, h = SIZE
    p = math.radians(pitch)
    f_px = (width / 2) / math.tan(math.radians(HFOV) / 2)
    forward = np.array([math.cos(p), 0.0, math.sin(p)])
    right = np.array([0.0, 1.0, 0.0])
    down = np.cross(right, forward)
    rel = points - np.array([0.0, 0.0, height])
    z = rel @ forward
    return np.column_stack([width / 2 + f_px * (rel @ right) / z, h / 2 + f_px * (rel @ down) / z])


def person(x: float, y: float) -> np.ndarray:
    """1.70 m 站立人员的 COCO 17 点（场景坐标，米）：只填自检用到的肩、髋、膝、踝，其余放在髋部。"""
    joints = np.tile([x, y, 0.92], (17, 1)).astype(float)
    for i, (dy, z) in zip(
        (5, 6, 11, 12, 13, 14, 15, 16),
        (
            (0.19, 1.42),
            (-0.19, 1.42),
            (0.1, 0.92),
            (-0.1, 0.92),
            (0.1, 0.5),
            (-0.1, 0.5),
            (0.1, 0.08),
            (-0.1, 0.08),
        ),
        strict=True,
    ):
        joints[i] = [x, y + dy, z]
    return joints


def checker(
    true_height: float, true_pitch: float, pose_height: float, pose_pitch: float, spots
) -> PoseChecker:
    c = PoseChecker({"height_m": pose_height, "pitch_deg": pose_pitch, "hfov_deg": HFOV}, SIZE)
    for i, (x, y) in enumerate(spots):
        px = project(person(x, y), true_height, true_pitch)
        c.add(i, px, np.full(17, 0.9), float(px[:, 1].max() - px[:, 1].min()), now=float(i))
    return c


SPREAD = [(x, y) for x in (2.0, 3.0, 4.5, 6.0, 8.0) for y in (-1.0, 0.0, 1.0, 2.0)]


def test_correct_pose_is_ok() -> None:
    result = checker(3.0, -30.0, 3.0, -30.0, SPREAD).check()

    assert result.status == "ok"
    assert result.person_height_m == pytest.approx(1.7, abs=0.05)
    assert result.suggested_height_m == pytest.approx(3.0, rel=0.05)
    assert result.suggested_pitch_deg == pytest.approx(-30.0, abs=1.0)


@pytest.mark.parametrize(("true_height", "true_pitch"), [(1.0, -8.0), (2.5, -15.0), (5.0, -45.0)])
def test_wrong_default_pose_is_suspect_with_suggestion(
    true_height: float, true_pitch: float
) -> None:
    """cam-03 的情形：实际约 1 m、近乎平视，参数仍为默认 3 m、−30°。"""
    spots = [(x, y) for x in (3.0, 4.0, 5.5, 7.0, 9.0) for y in (-1.0, 0.0, 1.0)]
    result = checker(true_height, true_pitch, 3.0, -30.0, spots).check()

    assert result.status == "suspect"
    assert result.suggested_height_m == pytest.approx(true_height, rel=0.15)
    assert result.suggested_pitch_deg == pytest.approx(true_pitch, abs=3.0)
    assert any("安装高度" in r or "俯角" in r for r in result.reasons)


def test_people_at_one_distance_only_suggest_height() -> None:
    """行人都在同一远近：俯角无法区分，只给高度。"""
    spots = [(4.0, y) for y in np.linspace(-1.5, 1.5, 20)]
    result = checker(2.0, -30.0, 3.0, -30.0, spots).check()

    assert result.suggested_pitch_deg is None
    assert result.suggested_height_m == pytest.approx(2.0, rel=0.15)
    assert any("俯角" in r for r in result.reasons)


def test_too_few_samples_is_insufficient() -> None:
    result = checker(3.0, -30.0, 3.0, -30.0, SPREAD[: MIN_SAMPLES - 1]).check()

    assert result.status == "insufficient"
    assert result.suggested_height_m is None


def test_implausible_speed_is_suspect_even_without_samples() -> None:
    c = PoseChecker({"height_m": 3.0, "pitch_deg": -30.0, "hfov_deg": HFOV}, SIZE)
    for speed in [8.0, 12.0, 30.0] * 5:
        c.add_speed(speed)

    result = c.check()
    assert result.status == "suspect"
    assert any("速度" in r for r in result.reasons)


def test_same_track_sampled_at_most_once_per_second() -> None:
    c = PoseChecker({"height_m": 3.0, "pitch_deg": -30.0, "hfov_deg": HFOV}, SIZE)
    px = project(person(4.0, 0.0), 3.0, -30.0)
    for i in range(10):
        c.add(1, px, np.full(17, 0.9), 400.0, now=i * 0.2)

    assert c.check().samples == 2


def test_sitting_or_bent_legs_are_not_samples() -> None:
    px = project(person(4.0, 0.0), 3.0, -30.0)
    bent = px.copy()
    bent[13] = bent[13] + [80, 0]  # 膝前移：髋—膝—踝夹角明显小于 160°
    bent[14] = bent[14] + [80, 0]

    assert standing(px, np.full(17, 0.9), 400.0, SIZE[1]) is not None
    assert standing(bent, np.full(17, 0.9), 400.0, SIZE[1]) is None
    assert standing(px, np.where(np.arange(17) == 15, 0.2, 0.9), 400.0, SIZE[1]) is None


def test_shoulder_height_matches_geometry() -> None:
    px = project(person(5.0, 0.5), 3.0, -30.0)
    h = shoulder_heights(px[[15]], px[[5]], 3.0, -30.0, HFOV, SIZE)

    assert h[0] == pytest.approx(1.34, abs=0.01)
