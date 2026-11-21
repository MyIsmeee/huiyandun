"""长时间静止与疑似打架（PPT 扩展模块）：以合成骨骼验证门限与排除条件；真实素材上的误报见 test_clips。"""

import numpy as np
import pytest
from test_behavior import FPS, hold, kinds, pose, run

from vision_engine.behavior import (
    FIGHT_MIN_SPAN_S,
    REPEAT_S,
    STILL_CONFIRM_S,
    STILL_GAP_S,
    STILL_SUSPECT_S,
    Behavior,
    BehaviorDetector,
)

STEP = 1 / FPS


def still(found: list[Behavior]) -> list[tuple[str, float, float]]:
    return kinds([b for b in found if b.behavior == "still"])


def test_standing_still_is_suspected_then_confirmed_and_repeats() -> None:
    seconds = STILL_CONFIRM_S + REPEAT_S + 1
    found = run(BehaviorDetector([]), hold(pose("stand"), 0, seconds))

    assert [b.behavior for b in found] == ["still"] * 3
    assert still(found) == [
        ("suspected", 0.0, STILL_SUSPECT_S),
        ("confirmed", 0.0, STILL_CONFIRM_S),
        ("confirmed", 0.0, STILL_CONFIRM_S + REPEAT_S),
    ]


def test_sitting_or_crouching_is_not_still() -> None:
    """坐、蹲不计时：坐在工位上不动是常态；站起后从头计。"""
    frames = hold(pose("squat"), 0, STILL_SUSPECT_S + 5)
    assert still(run(BehaviorDetector([]), frames)) == []
    hidden = pose("stand")
    hidden[13:17] = hidden[11]  # 腿被桌子挡住：关键点看不到时，置信度另设为 0
    detector = BehaviorDetector([])
    scores = np.full((1, 17), 0.9)
    scores[0, 13:17] = 0.0
    found = []
    for now, points in hold(hidden, 0, STILL_SUSPECT_S + 5):
        found += detector.update(np.array([7]), points[None], scores, now)
    assert still(found) == []


def test_taking_a_step_restarts_the_count() -> None:
    half = STILL_SUSPECT_S - 10
    frames = hold(pose("stand", x=300), 0, half) + hold(pose("stand", x=360), half, half)
    assert still(run(BehaviorDetector([]), frames)) == []


def test_lying_person_is_left_to_fall_detection() -> None:
    """倒地者由跌倒判定负责：长时间躺着只有跌倒事件，不再另发长时间静止。"""
    found = run(BehaviorDetector([]), hold(pose("lying"), 0, STILL_CONFIRM_S + 5))
    assert found and {b.behavior for b in found} == {"fall"}


def test_occlusion_longer_than_gap_restarts_the_count() -> None:
    """遮挡期间无法确认人还在原处：漏检超过 STILL_GAP_S 后重新计；短暂漏检不影响。"""
    first = STILL_SUSPECT_S - 20
    frames = hold(pose("stand"), 0, first) + hold(pose("stand"), first + STILL_GAP_S + 1, 30)
    assert still(run(BehaviorDetector([]), frames)) == []

    brief = hold(pose("stand"), 0, first) + hold(pose("stand"), first + STILL_GAP_S - 1, 30)
    assert still(run(BehaviorDetector([]), brief)) == [("suspected", 0.0, STILL_SUSPECT_S)]


def test_low_confidence_skeleton_is_not_reported() -> None:
    found = run(BehaviorDetector([]), hold(pose("stand"), 0, STILL_SUSPECT_S + 5), score=0.4)
    assert found == []


def person(x: float, frame: int, *, swing: float = 40, drift: float = 0) -> np.ndarray:
    """站立的人；手腕逐帧在髋部两侧来回（每帧移动 2 × swing 像素），整体每帧平移 drift 像素。"""
    points = pose("stand", x=x + drift * frame)
    side = swing if frame % 2 else -swing
    hip = points[11:13].mean(axis=0)
    points[9] = hip + (side, -60)
    points[10] = hip + (-side, -40)
    return points


def together(
    seconds: float, gap: float = 80, start: float = 0, **kwargs: dict[str, float]
) -> list[tuple[float, np.ndarray]]:
    """两人相距 gap 像素（躯干 55 像素）；kwargs 为（左侧, 右侧）各自的 person 参数。"""
    frames = []
    for i in range(round(seconds * FPS)):
        left = person(300, i, **{k: v[0] for k, v in kwargs.items()})
        right = person(300 + gap, i, **{k: v[1] for k, v in kwargs.items()})
        frames.append((start + i * STEP, np.stack([left, right])))
    return frames


def play(frames: list[tuple[float, np.ndarray]]) -> list[Behavior]:
    detector = BehaviorDetector([])
    scores = np.full((2, 17), 0.9)
    return [
        b for now, points in frames for b in detector.update(np.array([1, 2]), points, scores, now)
    ]


def test_two_people_within_reach_flailing_is_suspected_fight() -> None:
    found = play(together(6))

    assert [(b.behavior, b.level, b.track_id) for b in found] == [
        ("fight", "suspected", 1),
        ("fight", "suspected", 2),
    ]
    # 首帧没有上一帧可算速度；窗口须覆盖 FIGHT_MIN_SPAN_S
    assert found[0].start == pytest.approx(STEP) and found[0].end == pytest.approx(FIGHT_MIN_SPAN_S)
    assert found[0].confidence_avg == pytest.approx(0.9)


def test_fight_hint_repeats_while_it_lasts() -> None:
    found = play(together(REPEAT_S + FIGHT_MIN_SPAN_S + 2))
    assert [round(b.end, 1) for b in found if b.track_id == 1] == [
        FIGHT_MIN_SPAN_S,
        FIGHT_MIN_SPAN_S + REPEAT_S,
    ]


@pytest.mark.parametrize(
    ("case", "frames"),
    [
        ("相距太远", together(8, gap=400)),
        ("只有一方在动", together(8, swing=(40, 0))),
        ("动作幅度小（交谈、比划）", together(8, swing=(6, 6))),
        ("并肩奔跑：手臂同样快，但两人一起移动", together(8, drift=(30, 30))),
        ("只有一两下", together(1.5) + together(8, start=1.5, swing=(0, 0))),
    ],
)
def test_not_a_fight(case: str, frames: list[tuple[float, np.ndarray]]) -> None:
    assert play(frames) == [], case


def test_overlapping_people_at_different_depths_are_not_paired() -> None:
    """画面上挨着、实际一前一后：远处的人躯干短得多，不算伸手可及。"""
    frames = []
    for i in range(8 * FPS):
        near, far = person(300, i), person(380, i)
        anchor = far[15].copy()
        far = anchor + (far - anchor) * 0.5  # 以脚为准缩小一半
        frames.append((i * STEP, np.stack([near, far])))
    assert play(frames) == []


def test_fallen_person_is_not_paired() -> None:
    """有人倒地时由跌倒判定负责；施救者在旁边快速动作不算打架。"""
    frames = []
    for i in range(8 * FPS):
        helper = person(380, i)
        frames.append((i * STEP, np.stack([pose("lying", x=300), helper])))
    assert {b.behavior for b in play(frames)} <= {"fall"}
