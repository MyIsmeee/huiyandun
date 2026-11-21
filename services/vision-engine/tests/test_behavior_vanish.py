"""原地消失（疑似跌倒的补充线索）：站着的人在画面中间、不在走动时突然没了轨迹，满 VANISH_S 附近也没有新轨迹。"""

import numpy as np
from test_behavior import FPS, hold, pose

from vision_engine.behavior import VANISH_S, Behavior, BehaviorDetector

FRAME = (640, 480)  # 合成骨骼约 140 px 高（肩到踝），占画面高的 29%
EMPTY = (np.array([], int), np.empty((0, 17, 2)), np.empty((0, 17)))


def feed(
    frames: list[tuple[float, np.ndarray | None]],
    frame_size: tuple[int, int] | None = FRAME,
    others: dict[float, tuple[int, np.ndarray]] | None = None,
) -> list[Behavior]:
    """frames 为（时刻, 轨迹 7 的关键点）；None 表示画面中没有这条轨迹，仍以空帧推进。
    others 为某时刻另出现的（轨迹 ID, 关键点）。"""
    detector = BehaviorDetector([])
    found = []
    for now, points in frames:
        ids, keypoints = [], []
        if points is not None:
            ids.append(7)
            keypoints.append(points)
        if others and round(now, 2) in others:
            other_id, other = others[round(now, 2)]
            ids.append(other_id)
            keypoints.append(other)
        if ids:
            args = (np.array(ids), np.array(keypoints), np.full((len(ids), 17), 0.9))
        else:
            args = EMPTY
        found += detector.update(*args, now, frame_size)
    return [b for b in found if b.behavior == "fall"]


def vanish_after(standing: list, last: float, seconds: float = 5.0) -> list:
    """站姿片段之后画面中再没有这条轨迹 seconds 秒。"""
    return standing + hold(None, last + 1 / FPS, seconds)


def test_standing_then_vanishing_mid_frame_is_suspected_fall() -> None:
    standing = hold(pose("stand"), 0, 5)
    last = standing[-1][0]
    (event,) = feed(vanish_after(standing, last))
    assert (event.track_id, event.level) == (7, "suspected")
    assert event.start == last and round(event.end - event.start, 1) == VANISH_S
    assert event.confidence_avg >= 0.5


def test_walking_away_is_not_vanishing() -> None:
    """边走边消失（走远变小、走到他人身后）：消失前髋部移动快于 0.6 个躯干长度每秒。"""
    walking = [(i / FPS, pose("stand", x=200 + 12 * i)) for i in range(25)]  # 60 px/s，躯干 55 px
    assert feed(vanish_after(walking, walking[-1][0])) == []


def test_vanishing_at_frame_edge_is_walking_out() -> None:
    standing = hold(pose("stand", x=20), 0, 5)
    assert feed(vanish_after(standing, standing[-1][0])) == []


def test_new_track_nearby_is_same_person_with_new_id() -> None:
    """跟踪换了编号：消失后 1 s 内在原处出现新轨迹，交给新轨迹自行判定。"""
    standing = hold(pose("stand"), 0, 5)
    last = standing[-1][0]
    reappear = {round(last + i / FPS, 2): (8, pose("stand", x=310)) for i in range(1, 20)}
    assert feed(vanish_after(standing, last), others=reappear) == []


def test_short_lived_track_is_not_vanishing() -> None:
    """人流中一闪而过的轨迹：存在不满 3 s。"""
    standing = hold(pose("stand"), 0, 2)
    assert feed(vanish_after(standing, standing[-1][0])) == []


def test_small_far_person_is_not_vanishing() -> None:
    """远处的小人本就易漏检：外框高度不足画面高的 12%。"""
    standing = hold(pose("stand"), 0, 5)
    assert feed(vanish_after(standing, standing[-1][0]), frame_size=(640, 1400)) == []


def test_without_frame_size_vanishing_is_not_judged() -> None:
    """不知道画面尺寸就判断不了是否贴边走出画面，不发出。"""
    standing = hold(pose("stand"), 0, 5)
    assert feed(vanish_after(standing, standing[-1][0]), frame_size=None) == []


def test_lying_before_vanishing_is_left_to_fall_timer() -> None:
    """已按倒地姿态发出疑似的轨迹消失时不再重复发出。"""
    frames = hold(pose("stand"), 0, 2) + hold(pose("lying"), 2, 3)
    found = feed(vanish_after(frames, frames[-1][0]))
    assert [b.start for b in found] == [2.0]  # 只有倒地计时发出的那一次


def test_vanishing_is_reported_once() -> None:
    standing = hold(pose("stand"), 0, 5)
    assert len(feed(vanish_after(standing, standing[-1][0], seconds=9))) == 1
