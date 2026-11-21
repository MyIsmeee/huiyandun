"""跌倒与攀爬判定（FR-103、FR-104、C-CV-04）：以合成骨骼验证几何规则、持续时长、两级告警与重发。"""

import numpy as np
import pytest

from vision_engine.behavior import (
    CONFIRM_S,
    CONFIRM_UNSEEN_S,
    MIN_DURATION_S,
    REPEAT_S,
    TRANSITION_S,
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


def kinds(found: list[Behavior]) -> list[tuple[str, float, float]]:
    """（级别, 开始, 发出时刻）"""
    return [(b.level, round(b.start, 1), round(b.end, 1)) for b in found]


def fall(seconds: float, start: float = 1.0) -> list:
    """站立 start 秒后倒地 seconds 秒：看到了跌倒过程。"""
    return hold(pose("stand"), 0, start) + hold(pose("lying"), start, seconds)


def test_lying_for_two_seconds_is_suspected_fall() -> None:
    found = run(BehaviorDetector([]), hold(pose("lying"), 0, 3))

    assert found == [
        Behavior(7, "fall", pytest.approx(0.9), 0.0, MIN_DURATION_S, level="suspected")
    ]


def test_falling_and_staying_down_is_confirmed() -> None:
    """站立后倒地：满 2 s 发疑似，倒地不动满 CONFIRM_S 发确认（TK-160）。"""
    found = run(BehaviorDetector([]), fall(CONFIRM_S + 2))

    assert kinds(found) == [("suspected", 1.0, 3.0), ("confirmed", 1.0, 1.0 + CONFIRM_S)]
    assert found[1] == Behavior(7, "fall", pytest.approx(0.9), 1.0, 1.0 + CONFIRM_S)


def test_getting_up_before_confirmation_is_only_suspected() -> None:
    """弯腰捡物、短暂坐地后站起：只有疑似，不进入物理告警。"""
    frames = fall(CONFIRM_S - 2) + hold(pose("stand"), CONFIRM_S - 1, 5)

    assert [b.level for b in run(BehaviorDetector([]), frames)] == ["suspected"]


def test_moving_on_the_ground_is_not_confirmed() -> None:
    """在地上爬行（髋部每秒移动约 1.5 个躯干长）15 s：不确认；停下后近 STILL_WINDOW_S 内基本不动才确认。"""
    crawl = [(1 + i / FPS, pose("lying", x=100 + 17 * i)) for i in range(round(15 * FPS))]
    rest = hold(pose("lying", x=100 + 17 * 75), 16, 6)

    found = run(BehaviorDetector([]), hold(pose("stand", x=100), 0, 1) + crawl + rest)

    assert [b.level for b in found] == ["suspected", "confirmed"]
    assert found[1].end > 16  # 爬行期间不确认


def test_already_lying_needs_longer_confirmation() -> None:
    """一出现就躺着（没看到跌倒过程，可能是躺卧休息）：确认要等 CONFIRM_UNSEEN_S。"""
    found = run(BehaviorDetector([]), hold(pose("lying"), 0, CONFIRM_UNSEEN_S + 1))

    assert kinds(found) == [("suspected", 0.0, 2.0), ("confirmed", 0.0, CONFIRM_UNSEEN_S)]


def test_upright_long_before_lying_is_not_a_seen_fall() -> None:
    frames = hold(pose("stand"), 0, 1) + hold(None, 1, TRANSITION_S + 1)
    frames += hold(pose("lying"), TRANSITION_S + 2, CONFIRM_S + 2)

    assert [b.level for b in run(BehaviorDetector([]), frames)] == ["suspected"]


def test_detection_gap_keeps_seen_fall() -> None:
    """倒地后漏检超过 GAP_S：计时重新开始，但仍算看到了跌倒过程，按 CONFIRM_S 确认。"""
    frames = fall(3) + hold(None, 4, 2) + hold(pose("lying"), 6, CONFIRM_S + 1)

    assert kinds(run(BehaviorDetector([]), frames)) == [
        ("suspected", 1.0, 3.0),
        ("suspected", 6.0, 8.0),
        ("confirmed", 6.0, 6.0 + CONFIRM_S),
    ]


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


def test_continuing_fall_repeats_confirmation_every_interval() -> None:
    """确认后每 REPEAT_S 重发确认，使设备保持物理告警；疑似不再重发。"""
    found = run(BehaviorDetector([]), fall(CONFIRM_S + REPEAT_S + 1))

    assert kinds(found) == [
        ("suspected", 1.0, 3.0),
        ("confirmed", 1.0, 1.0 + CONFIRM_S),
        ("confirmed", 1.0, 1.0 + CONFIRM_S + REPEAT_S),
    ]


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


def test_long_fall_keeps_running_confidence_without_per_frame_history() -> None:
    """持续倒地一小时：置信度均值只记累计（不随帧数多存），重发的均值仍是各帧的平均。"""
    detector = BehaviorDetector([])
    found = run(detector, fall(3600), score=0.8)

    timer = detector._tracks[7].fall.timer
    assert timer.count == 3600 * FPS
    assert not any(isinstance(value, list) for value in vars(timer).values())
    assert found[-1].confidence_avg == pytest.approx(0.8)


def test_running_confidence_equals_builtin_sum_bit_for_bit() -> None:
    """累计的均值与逐帧存下再用 sum 求均值逐位相同：改为累计不改变任何判定与上报的数值。"""
    from vision_engine.behavior import _Timer

    scores = np.random.default_rng(0).uniform(0.3, 1.0, 5000).tolist() + [1e-9, 0.1, 0.7, 1e9, 0.2]
    timer = _Timer()
    for i, score in enumerate(scores):
        timer.update(True, score, i * 0.2)
        assert timer.mean == sum(scores[: i + 1]) / (i + 1)
