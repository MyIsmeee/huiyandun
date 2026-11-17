"""骨骼动作模型复核（action.py）：片段预处理、推理节奏，以及与几何规则的联合判定（behavior.py）。
模型以替身代替，只验证接线与门限；真实权重在录制片段上的效果见 models/cards/stgcnpp-ntu60-2d.md。"""

from typing import cast

import numpy as np
import pytest
from test_behavior import FPS, hold, kinds, pose
from test_behavior_social import person

from vision_engine.action import (
    CENTER_Y,
    CLIP_LEN,
    FALL,
    FIGHT,
    INTERVAL_S,
    NTU_H,
    TARGET_PX,
    ActionModel,
    ActionRecognizer,
    clip,
)
from vision_engine.behavior import CONFIRM_S, MIN_DURATION_S, Behavior, BehaviorDetector

SCORES = np.full(17, 0.9)


class Stub:
    """替身模型：单人片段给出 fall 的跌倒概率，双人片段给出 fight 的打人概率；记下每次调用的批量。"""

    def __init__(self, fall: float = 0.0, fight: float = 0.0) -> None:
        self.fall, self.fight, self.batches = fall, fight, []

    def __call__(self, clips: np.ndarray) -> np.ndarray:
        self.batches.append(clips.shape)
        probs = np.zeros((len(clips), 60))
        for i, c in enumerate(clips):
            if c[1].any():
                probs[i, FIGHT[0]] = self.fight
            else:
                probs[i, FALL] = self.fall
        return probs


def samples(points: np.ndarray, seconds: float, scores: np.ndarray = SCORES) -> list:
    return [(i / FPS, points, scores) for i in range(round(seconds * FPS))]


def test_single_person_clip_is_centered_scaled_and_padded() -> None:
    out = clip([samples(pose("stand"), 3)], now=3.0)
    assert out is not None and out.shape == (2, CLIP_LEN, 17, 3)
    assert not out[1].any()  # 第二人补零
    hips = out[0, :, [11, 12], :2].mean(axis=0)
    np.testing.assert_allclose(hips.mean(axis=0), [0, CENTER_Y], atol=1e-6)
    # 人高 140 px（脚底到肩）缩放到 TARGET_PX，按 NTU 画面半高归一化
    height = out[0, 0, 15, 1] - out[0, 0, 5, 1]
    assert height == pytest.approx(TARGET_PX / (NTU_H / 2), rel=1e-6)
    np.testing.assert_allclose(out[0, ..., 2], 0.9)


def test_short_or_broken_skeleton_gives_no_clip() -> None:
    assert clip([samples(pose("stand"), 1)], now=1.0) is None  # 不足 MIN_SPAN_S
    hidden = np.full(17, 0.1)
    hidden[[5, 6, 11, 12]] = 0.9  # 只看得到肩与髋：骨骼残缺
    assert clip([samples(pose("stand"), 3, hidden)], now=3.0) is None


def test_recognizer_runs_once_per_interval_and_pairs_only_people_within_reach() -> None:
    model = Stub(fall=0.8, fight=0.7)
    recognizer = ActionRecognizer(cast(ActionModel, model))
    for i in range(round(4 * FPS)):
        now = i / FPS
        points = np.stack([pose("stand", x=300), pose("stand", x=380), pose("stand", x=900)])
        recognizer.update(np.array([1, 2, 3]), points, np.tile(SCORES, (3, 1)), now)
    assert len(model.batches) <= 4 / INTERVAL_S + 1
    assert model.batches[-1][0] == 4  # 三个单人片段 + 伸手可及的 1、2 两人
    assert recognizer.fall_peak(1, 4.0, within=2) == 0.8
    assert recognizer.fight_hits((1, 2), 4.0, within=4, threshold=0.6) >= 2
    assert (1, 3) not in recognizer.fights


def detect(model: Stub, frames: list) -> list[Behavior]:
    detector = BehaviorDetector([], ActionRecognizer(cast(ActionModel, model)))
    found = []
    for now, points in frames:
        found += detector.update(np.array([7]), points[None], SCORES[None], now)
    return found


def test_model_seeing_the_fall_confirms_without_waiting() -> None:
    """规则发疑似（倒地满 2 s）时模型近期认为在跌倒：立即确认，不等倒地不动满 CONFIRM_S。"""
    frames = hold(pose("stand"), 0, 3) + hold(pose("lying"), 3, MIN_DURATION_S + 1)
    found = [b for b in detect(Stub(fall=0.9), frames) if b.behavior == "fall"]
    assert [b.level for b in found][-2:] == ["suspected", "confirmed"]
    assert found[-1].end == found[-2].end

    # 模型没看到跌倒：仍按规则等满 CONFIRM_S
    slow = hold(pose("stand"), 0, 3) + hold(pose("lying"), 3, CONFIRM_S + 1)
    found = [b for b in detect(Stub(fall=0.1), slow) if b.behavior == "fall"]
    assert kinds(found)[-1] == ("confirmed", 3.0, round(3 + CONFIRM_S, 1))


def test_model_alone_raises_only_a_suspected_fall() -> None:
    """规则没看到倒地（如朝镜头倒）、模型的跌倒概率高：只发疑似，置信度取模型概率；不重复发。"""
    found = detect(Stub(fall=0.8), hold(pose("stand"), 0, 6))
    falls = [b for b in found if b.behavior == "fall"]
    assert [(b.level, b.confidence_avg) for b in falls] == [("suspected", 0.8)]
    assert detect(Stub(fall=0.5), hold(pose("stand"), 0, 6)) == []


def fighting(model: Stub, gap: float, swing: float = 40) -> list[Behavior]:
    detector = BehaviorDetector([], ActionRecognizer(cast(ActionModel, model)))
    found = []
    for i in range(round(5 * FPS)):
        points = np.stack([person(300, i, swing=swing), person(300 + gap, i, swing=swing)])
        found += detector.update(np.array([1, 2]), points, np.tile(SCORES, (2, 1)), i / FPS)
    return [b for b in found if b.behavior == "fight"]


def test_model_and_rule_together_confirm_a_fight_for_both() -> None:
    """两人伸手可及、双方手腕快速运动，且模型多次认为在打人：双方各发一条确认。"""
    found = [b for b in fighting(Stub(fight=0.9), gap=80) if b.level == "confirmed"]
    assert sorted(b.track_id for b in found) == [1, 2]


def test_model_alone_or_overlapping_tracks_do_not_confirm_a_fight() -> None:
    """离得远、模型不认、手腕不动（坐着聊天、并排站），或同一人被拆成两条重叠轨迹：都不确认。"""
    for found in (
        fighting(Stub(fight=0.9), gap=400),
        fighting(Stub(fight=0.5), gap=80),
        fighting(Stub(fight=0.9), gap=80, swing=0),
        fighting(Stub(fight=0.9), gap=10),
    ):
        assert [b for b in found if b.level == "confirmed"] == []


def test_model_splits_large_batches() -> None:
    """人多时分批推理，每批不超过 MAX_BATCH：显存上限按此实测。"""
    from vision_engine.action import MAX_BATCH

    class Session:
        def __init__(self) -> None:
            self.sizes: list[int] = []

        def get_inputs(self) -> list:
            return [type("Input", (), {"name": "keypoints"})()]

        def run(self, _: object, feed: dict) -> list:
            batch = feed["keypoints"]
            self.sizes.append(len(batch))
            return [np.full((len(batch), 60), len(self.sizes), float)]

    session = Session()
    out = ActionModel(cast(object, session))(np.zeros((MAX_BATCH * 2 + 1, 2, CLIP_LEN, 17, 3)))  # type: ignore[arg-type]
    assert max(session.sizes) <= MAX_BATCH and sum(session.sizes) == MAX_BATCH * 2 + 1
    assert out.shape == (MAX_BATCH * 2 + 1, 60)


def test_model_runs_one_inference_at_a_time() -> None:
    """各路摄像头共用会话：同时推理时逐次进行。两路并发会超出 ACTION_MEM_MB，cuDNN 执行失败后显存访问越界，
    整个进程的 CUDA 上下文随之损坏、各路识别全部失败（2026-11-17 实测）。"""
    import threading
    import time

    class Session:
        def __init__(self) -> None:
            self.running = 0
            self.peak = 0
            self._count = threading.Lock()

        def get_inputs(self) -> list:
            return [type("Input", (), {"name": "keypoints"})()]

        def run(self, _: object, feed: dict) -> list:
            with self._count:
                self.running += 1
                self.peak = max(self.peak, self.running)
            time.sleep(0.02)
            with self._count:
                self.running -= 1
            return [np.zeros((len(feed["keypoints"]), 60))]

    session = Session()
    model = ActionModel(cast(object, session))  # type: ignore[arg-type]
    clips = np.zeros((1, 2, CLIP_LEN, 17, 3))
    threads = [threading.Thread(target=model, args=(clips,)) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert session.peak == 1
