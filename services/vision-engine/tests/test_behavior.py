"""跌倒与攀爬判定（FR-103、FR-104、C-CV-04）：以合成骨骼验证几何规则、持续时长与重发。"""

import numpy as np
import pytest

from vision_engine.behavior import (
    MIN_DURATION_S,
    REPEAT_S,
    Behavior,
    BehaviorDetector,
    ClimbLine,
)

FPS = 5
LINE = [100, 300, 500, 300]  # 水平警戒线 y=300：y 更小（画面更高）为线上


def pose(name: str, x: float = 300, feet: float = 400) -> np.ndarray:
    """COCO 17 关键点，人高约 170 px；只填判定用到的肩、髋、膝、踝，其余放在髋部。"""
    joints = {
        # 肩、髋、膝、踝相对脚底中点的偏移 (dx, dy)
        "stand": [(0, -140), (0, -85), (0, -45), (0, 0)],
        "lying": [(140, 0), (85, 0), (45, 0), (0, 0)],
        "bend": [(50, -90), (0, -85), (0, -45), (0, 0)],  # 弯腰捡物：躯干水平，髋部仍高
        "squat": [(0, -80), (0, -30), (20, -35), (0, 0)],
        "propped": [(140, 0), (85, -35), (45, 0), (0, 0)],  # 倒地后撑起髋部：髋高约 0.54 个躯干
    }[name]
    (sx, sy), (hx, hy), (kx, ky), (ax, ay) = joints
    points = np.tile([x + hx, feet + hy], (17, 1)).astype(float)
    for i, (dx, dy) in zip(
        (5, 6, 11, 12, 13, 14, 15, 16),
        [(sx - 10, sy), (sx + 10, sy), (hx - 8, hy), (hx + 8, hy)]
        + [(kx, ky)] * 2
        + [(ax, ay)] * 2,
        strict=True,
    ):
        points[i] = (x + dx, feet + dy)
    return points


def run(
    detector: BehaviorDetector, frames: list[tuple[float, np.ndarray | None]], score: float = 0.9
) -> list[Behavior]:
    """frames 为（时刻, 关键点）；关键点为 None 表示该帧轨迹漏检。轨迹 ID 固定为 7。"""
    found = []
    for now, points in frames:
        if points is None:
            continue
        scores = np.full((1, 17), score)
        found += detector.update(np.array([7]), points[None], scores, now)
    return found


def hold(points: np.ndarray | None, start: float, seconds: float) -> list:
    return [(start + i / FPS, points) for i in range(round(seconds * FPS))]


def test_lying_for_two_seconds_is_fall() -> None:
    found = run(BehaviorDetector([]), hold(pose("lying"), 0, 3))

    assert found == [Behavior(7, "fall", pytest.approx(0.9), 0.0, MIN_DURATION_S)]


def test_shorter_than_min_duration_is_not_fall() -> None:
    frames = hold(pose("lying"), 0, MIN_DURATION_S) + hold(pose("stand"), MIN_DURATION_S, 3)

    assert run(BehaviorDetector([]), frames) == []


@pytest.mark.parametrize("name", ["stand", "bend", "squat"])
def test_upright_bend_and_squat_are_not_fall(name: str) -> None:
    assert run(BehaviorDetector([]), hold(pose(name), 0, 10)) == []


def test_low_keypoint_confidence_is_not_fall() -> None:
    assert run(BehaviorDetector([]), hold(pose("lying"), 0, 10), score=0.4) == []


def test_short_miss_does_not_restart_timer() -> None:
    frames = hold(pose("lying"), 0, 1.2) + hold(None, 1.2, 0.6) + hold(pose("lying"), 1.8, 1)

    assert [b.start for b in run(BehaviorDetector([]), frames)] == [0.0]


def test_long_miss_restarts_timer() -> None:
    frames = hold(pose("lying"), 0, 1.2) + hold(None, 1.2, 1.8) + hold(pose("lying"), 3, 3)

    assert [(b.start, b.end) for b in run(BehaviorDetector([]), frames)] == [(3.0, 5.0)]


def test_standing_up_interrupts() -> None:
    frames = (
        hold(pose("lying"), 0, 1.6) + hold(pose("stand"), 1.6, 0.2) + hold(pose("lying"), 1.8, 1)
    )

    assert run(BehaviorDetector([]), frames) == []


def test_borderline_frame_after_fall_does_not_split_it() -> None:
    """#134：发出跌倒事件后，髋部略抬过进入门限的一帧不中断（回差），一次跌倒只发一条事件。"""
    frames = (
        hold(pose("lying"), 0, 2.4) + hold(pose("propped"), 2.4, 0.2) + hold(pose("lying"), 2.6, 3)
    )

    assert [b.start for b in run(BehaviorDetector([]), frames)] == [0.0]


def test_borderline_frame_before_fall_interrupts() -> None:
    """发出前仍按进入门限：可疑姿态不因回差被延长成跌倒。"""
    frames = (
        hold(pose("lying"), 0, 1.2) + hold(pose("propped"), 1.2, 0.2) + hold(pose("lying"), 1.4, 3)
    )

    assert [b.start for b in run(BehaviorDetector([]), frames)] == [1.4]
    assert run(BehaviorDetector([]), hold(pose("propped"), 0, 3)) == []


def test_continuing_fall_repeats_every_interval() -> None:
    found = run(BehaviorDetector([]), hold(pose("lying"), 0, REPEAT_S + 5))

    assert [(b.start, b.end) for b in found] == [(0.0, 2.0), (0.0, 2.0 + REPEAT_S)]


def test_ankles_crossing_line_and_staying_is_climb() -> None:
    frames = hold(pose("stand", feet=400), 0, 1) + hold(pose("stand", feet=250), 1, 3)

    found = run(BehaviorDetector([LINE]), frames)

    assert [(b.behavior, b.start, b.end) for b in found] == [("climb", 1.0, 3.0)]


def test_always_beyond_line_is_not_climb() -> None:
    """线外道路上行走的人从未出现在线下，不算攀爬。"""
    assert run(BehaviorDetector([LINE]), hold(pose("stand", feet=250), 0, 10)) == []


def test_crossing_outside_line_span_is_not_climb() -> None:
    """绕过线段端点（如经大门）不算越线。"""
    frames = hold(pose("stand", feet=400), 0, 1) + hold(pose("stand", x=700, feet=250), 1, 5)

    assert run(BehaviorDetector([LINE]), frames) == []


def test_brief_crossing_is_not_climb() -> None:
    frames = (
        hold(pose("stand", feet=400), 0, 1)
        + hold(pose("stand", feet=250), 1, 1.6)
        + hold(pose("stand", feet=400), 2.6, 3)
    )

    assert run(BehaviorDetector([LINE]), frames) == []


def test_steep_line_sides() -> None:
    """近乎竖直的墙顶线（如俯拍斜墙）：左上为线上，右下为线下。"""
    line = ClimbLine(150, 330, 225, 135)

    assert line.side(125, 270) == "above"
    assert line.side(250, 300) == "below"
    assert line.side(400, 600) is None


@pytest.mark.parametrize("line", [[600, 300, 600, 200], [600, 300, 600, 300]])
def test_vertical_or_zero_length_line_rejected(line: list[float]) -> None:
    """竖直（含长度为 0）的线无法区分线上与线下；在构造时拒绝，而不是在某一帧计算时出错。"""
    with pytest.raises(ValueError, match="竖直"):
        BehaviorDetector([line])


def test_tracks_are_independent() -> None:
    detector = BehaviorDetector([])
    lying, standing = pose("lying"), pose("stand", x=600)
    found = []
    for now, _ in hold(None, 0, 3):
        points = np.stack([lying, standing])
        found += detector.update(np.array([1, 2]), points, np.full((2, 17), 0.9), now)

    assert [(b.track_id, b.behavior) for b in found] == [(1, "fall")]
