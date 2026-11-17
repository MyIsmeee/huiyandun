"""两阶段骨骼（detector.TopDownPose、refine）：按人员框换成逐人模型的骨骼；被挡住的腿不信；横躺者保留更清楚的一方。"""

import numpy as np

from vision_engine.detector import LOWER_BODY, LOWER_BODY_MIN, TopDownPose, refine


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
