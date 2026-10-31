"""素材片段测试（TK-022、SC-03）：回放素材录制的骨骼轨迹，目标动作检出、常态片段零告警。

clips/*.npz 由 tools/dev/record_keypoints.py 从 demo/media/src/ 的同名片段录制，只含关键点数字；
检测器或跟踪参数变化后须重新录制。只报告、不断言的片段（TK-022 #83，见模型卡"限制"）：
fall-1 俯拍、人朝镜头倒地且此前瘫坐于椅中，二维骨骼无法区分；climb-2 手持拍摄、画面晃动。
"""

from pathlib import Path

import numpy as np
import pytest

from vision_engine.behavior import GAP_S, Behavior, BehaviorDetector

CLIPS = Path(__file__).parent / "clips"
CLIMB_1_LINE = [300, 700, 475, 340]  # climb-1 画面（1026×720）中院墙的墙顶


def replay(name: str, lines: list[list[float]]) -> list[Behavior]:
    data = np.load(CLIPS / f"{name}.npz")
    detector = BehaviorDetector(lines)
    found = []
    for now in np.unique(data["t"]):
        at = data["t"] == now
        found += detector.update(
            data["track_id"][at],
            data["keypoints"][at].astype(float),
            data["keypoint_scores"][at].astype(float),
            float(now),
        )
    return found


@pytest.mark.parametrize(
    ("name", "lines", "behavior", "start_s"),
    [
        ("fall-2", [], "fall", (3, 6)),  # 约 3 s 倒地，此后一直躺在路口
        ("climb-1", [CLIMB_1_LINE], "climb", (12, 16)),  # 约 10～13 s 翻越院墙，此后在墙外
    ],
)
def test_target_action_detected_and_nothing_before(
    name: str, lines: list[list[float]], behavior: str, start_s: tuple[float, float]
) -> None:
    """目标动作在发生时检出；此前（如攀爬前在院内走动）零告警，此后只有同一行为的重发。"""
    found = replay(name, lines)

    summary = [(b.behavior, b.track_id, round(b.start, 1)) for b in found]
    assert found and start_s[0] <= found[0].start <= start_s[1], summary
    assert all(b.behavior == behavior and b.start >= start_s[0] for b in found), summary


def test_fall_2_one_track_one_event() -> None:
    """#134：同一倒地者只有一条轨迹、一条 fall 事件（片段约 20 s，短于重发间隔），
    其轨迹从倒地起持续 ≥ 10 s、中间不断（漏检不超过 GAP_S）。"""
    found = replay("fall-2", [])

    assert [b.behavior for b in found] == ["fall"], [(b.track_id, round(b.start, 1)) for b in found]
    data = np.load(CLIPS / "fall-2.npz")
    t = data["t"][data["track_id"] == found[0].track_id]
    after = t[t >= found[0].start]
    assert after.max() - found[0].start >= 10
    assert np.diff(after).max() <= GAP_S


@pytest.mark.parametrize("name", ["crowd-1", "actions-1"])
def test_normal_clip_has_no_alerts(name: str) -> None:
    """crowd-1 为 5 分钟人流（SC-03）；actions-1 含跳、跑、走、下蹲。"""
    found = replay(name, [])

    assert found == [], [(b.behavior, b.track_id, round(b.start, 1)) for b in found]
