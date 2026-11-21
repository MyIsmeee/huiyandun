"""两阶段骨骼（detector.TopDownPose、refine）：按人员框换成逐人模型的骨骼；被挡住的腿不信；横躺者保留更清楚的一方。"""

import numpy as np

from vision_engine.detector import (
    LOWER_BODY,
    LOWER_BODY_MIN,
    TOPDOWN_BATCHES,
    BatchRTMPose,
    TopDownPose,
    refine,
)


class FakeModel:
    """rtmlib RTMPose 的替身：每个框给出固定的关键点与置信度。"""

    def __init__(self, scores: np.ndarray) -> None:
        self.scores = scores
        self.boxes: list = []

    def __call__(self, image: np.ndarray, boxes: list) -> tuple[np.ndarray, np.ndarray]:
        self.boxes = boxes
        n = len(boxes)
        return np.full((n, 17, 2), 7.0), np.tile(self.scores, (n, 1))


def topdown(scores: np.ndarray) -> TopDownPose:
    pose = TopDownPose.__new__(TopDownPose)
    pose._model = FakeModel(scores)  # type: ignore[assignment]
    return pose


def test_lower_body_below_threshold_treated_as_hidden() -> None:
    scores = np.full(17, 0.8)
    scores[LOWER_BODY] = [0.39, 0.4, 0.2, 0.9]
    _, out = topdown(scores)(np.zeros((10, 10, 3)), np.array([[0, 0, 5, 9]]))
    assert out[0, LOWER_BODY].tolist() == [0.0, 0.4, 0.0, 0.9]
    assert out[0, 5] == 0.8 and LOWER_BODY_MIN == 0.4


def test_refine_replaces_upright_people_keeps_clearer_lying_skeleton() -> None:
    boxes = np.array([[0, 0, 40, 100], [0, 0, 100, 40], [0, 0, 100, 40]], float)  # 站、躺、躺
    points = np.zeros((3, 17, 2))
    scores = np.array([np.full(17, 0.9), np.full(17, 0.9), np.full(17, 0.2)])
    out_points, out_scores = refine(
        topdown(np.full(17, 0.5)), np.zeros((120, 120, 3)), boxes, points, scores
    )
    # 直立的一律换成逐人模型（即使原来的置信度更高：两个模型的置信度尺度不同）
    assert out_points[0, 0].tolist() == [7.0, 7.0] and out_scores[0, 0] == 0.5
    # 横躺者：原骨骼（旋转推理补出的）更清楚时保留，否则换
    assert out_points[1, 0].tolist() == [0.0, 0.0] and out_scores[1, 0] == 0.9
    assert out_points[2, 0].tolist() == [7.0, 7.0]


def test_refine_without_people_does_nothing() -> None:
    points, scores = np.zeros((0, 17, 2)), np.zeros((0, 17))
    out = refine(topdown(np.full(17, 0.5)), np.zeros((10, 10, 3)), np.zeros((0, 4)), points, scores)
    assert out[0].shape == (0, 17, 2) and out[1].shape == (0, 17)


class SimccSession:
    """RTMPose 会话的替身：记录每次推理的批量；第 i 个人的 simcc 峰值在 x = i + 1、y = 2(i + 1) 处。"""

    def __init__(self) -> None:
        self.sizes: list[int] = []

    def get_inputs(self) -> list:
        return [type("Input", (), {"name": "input"})()]

    def run(self, _: object, feed: dict) -> list[np.ndarray]:
        batch = feed["input"]
        assert batch.dtype == np.float32 and batch.shape[1:] == (3, 256, 192)
        start = sum(self.sizes)
        self.sizes.append(len(batch))
        x, y = np.zeros((len(batch), 17, 384)), np.zeros((len(batch), 17, 512))
        for k in range(len(batch)):
            x[k, :, start + k + 1] = y[k, :, 2 * (start + k + 1)] = 0.8
        return [x, y]


def test_batch_rtmpose_runs_people_together_in_fixed_shapes() -> None:
    """一帧里的人一次推理（rtmlib 逐框各一次），批量补齐到 TOPDOWN_BATCHES 中的一档，超过最大一档时分批。"""
    session = SimccSession()
    model = BatchRTMPose(session)  # type: ignore[arg-type]
    image = np.zeros((480, 640, 3), np.uint8)
    for n, sizes in ((3, [4]), (16, [16]), (17, [16, 16])):
        session.sizes = []
        boxes = [[10.0 * i, 0.0, 10.0 * i + 96, 128.0] for i in range(n)]
        points, scores = model(image, boxes)
        assert session.sizes == sizes and set(sizes) <= set(TOPDOWN_BATCHES)
        assert points.shape == (n, 17, 2) and scores.shape == (n, 17)
        # 各人的结果按框的顺序：框 96×128 外扩 1.25 倍为 120×160（恰为输入的宽高比），simcc 每格为输入的 1/2
        scale = np.array([120.0, 160.0])
        for i, box in enumerate(boxes):
            center = np.array([box[0] + 48, 64.0])
            expected = (
                np.array([(i + 1) / 2 / 192, 2 * (i + 1) / 2 / 256]) * scale + center - scale / 2
            )
            assert np.allclose(points[i, 0], expected)
        assert np.allclose(scores, 0.8)
