"""画面级打架（violence.py）：两人贴近才推理、连续高分才确认、缓冲与重发。模型以替身代替。"""

from typing import cast

import numpy as np

from vision_engine.violence import (
    CLIP_LEN,
    FIGHT_PROB,
    REPEAT_S,
    ViolenceDetector,
    ViolenceModel,
    closest_pair,
    normalize,
    prepare,
)


class Stub:
    def __init__(self, prob: float) -> None:
        self.prob, self.calls = prob, 0

    def __call__(self, clip: np.ndarray) -> float:
        assert clip.shape == (CLIP_LEN, 3, 224, 224)
        self.calls += 1
        return self.prob


FRAME = np.zeros((720, 1280, 3), np.uint8)
CLOSE = [(1, (100.0, 100.0, 200.0, 400.0)), (2, (180.0, 110.0, 280.0, 400.0))]
FAR = [(1, (100.0, 100.0, 200.0, 400.0)), (2, (900.0, 100.0, 1000.0, 400.0))]


def run(prob: float, people: list, seconds: float = 6.0, fps: int = 5) -> tuple[Stub, list]:
    model = Stub(prob)
    det = ViolenceDetector(cast(ViolenceModel, model))
    hits = [r for i in range(round(seconds * fps)) if (r := det.update(FRAME, i / fps, people))]
    return model, hits


def test_prepare_crops_center_square_and_normalizes() -> None:
    frame = np.zeros((720, 1280, 3), np.uint8)
    frame[:, 640:] = (255, 0, 0)  # 右半边蓝色（BGR）
    out = prepare(frame)
    assert out.shape == (224, 224, 3)
    assert out[0, -1].tolist() == [0, 0, 255]  # 转成 RGB
    clip = normalize([out] * CLIP_LEN)
    assert clip.shape == (CLIP_LEN, 3, 224, 224) and clip.dtype == np.float32


def test_pair_must_be_close_and_at_similar_depth() -> None:
    assert closest_pair(CLOSE) == (1, 2)
    assert closest_pair(FAR) is None
    near_far = [
        (1, (100.0, 100.0, 200.0, 400.0)),
        (2, (150.0, 300.0, 180.0, 380.0)),
    ]  # 一大一小：一前一后
    assert closest_pair(near_far) is None


def test_high_scores_with_two_people_close_confirm_once_per_interval() -> None:
    model, hits = run(0.95, CLOSE)
    assert len(hits) == 1
    a, b, _, prob = hits[0]
    assert (a, b) == (1, 2) and prob >= FIGHT_PROB
    assert model.calls <= 6  # 每秒至多一次

    _, again = run(0.95, CLOSE, seconds=REPEAT_S + 8)
    assert len(again) == 2  # 持续期间每 REPEAT_S 重发


def test_no_inference_without_a_close_pair_and_no_alert_on_low_scores() -> None:
    model, hits = run(0.99, FAR)
    assert (model.calls, hits) == (0, [])  # 单人剧烈运动、两人离得远：不推理
    model, hits = run(0.5, CLOSE)
    assert model.calls > 0 and hits == []


def test_gap_in_frames_restarts_the_clip() -> None:
    model = Stub(0.95)
    det = ViolenceDetector(cast(ViolenceModel, model))
    for i in range(10):
        det.update(FRAME, i / 5, CLOSE)
    for i in range(10):
        det.update(FRAME, 10 + i / 5, CLOSE)  # 断了 8 秒：缓冲清空，不足 16 帧不推理
    assert model.calls == 0
