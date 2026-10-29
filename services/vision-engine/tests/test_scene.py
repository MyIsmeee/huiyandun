"""场景感知（TK-118、FR-108）：分割结果归并、投影、平滑与无效帧。

投影以已知单应矩阵检验平面坐标；分割以假会话代替模型。
"""

from collections import deque
from types import SimpleNamespace
from typing import Any, cast

import numpy as np
import pytest

from vision_engine.geometry import GroundMapping
from vision_engine.scene import (
    GRID,
    MAX_POLYGONS,
    ScenePerception,
    Segmenter,
    label,
    smooth,
)

SIZE = 640  # 测试画面 640×640：每格 10 像素
# 正视地面：1 像素 = 1 cm，即每格 0.1 m
TOP_DOWN = GroundMapping.fit([[u, v, u / 100, v / 100] for u in (0, 1000) for v in (0, 700)])
POSE = {"x": 3.2, "y": 10.0, "range_m": 50.0}  # 摄像头位于画面下方之外


def mapping(m: GroundMapping | None) -> GroundMapping:
    assert m is not None
    return m


def perception(
    pose: dict[str, float] = POSE, ground: GroundMapping | None = TOP_DOWN, segmenter: Any = None
) -> ScenePerception:
    return ScenePerception("cam-01", mapping(ground), pose, cast(Segmenter, segmenter))


def grid(**blocks: list[tuple[slice, slice]]) -> np.ndarray:
    labels = np.zeros((GRID, GRID), np.uint8)
    for name, regions in blocks.items():
        for rows, cols in regions:
            labels[rows, cols] = label(name)
    return labels


def blank(value: int = 100) -> np.ndarray:
    return np.full((SIZE, SIZE, 3), value, np.uint8)


# --- 投影 ---


def test_surface_outline_on_known_homography() -> None:
    labels = grid(road=[(slice(10, 30), slice(10, 30))])

    (surface,) = perception().project(labels, blank())["surfaces"]

    polygon = np.array(surface["polygon"])
    assert surface["class"] == "road"
    assert polygon.min(0) == pytest.approx([1.05, 1.05])  # 格中心：(10 + 0.5) × 0.1 m
    assert polygon.max(0) == pytest.approx([2.95, 2.95])


def test_surface_holes_are_filled() -> None:
    """路面上的人与车辆不在场景中，其遮挡处不留孔洞。"""
    labels = grid(road=[(slice(10, 30), slice(10, 30))])
    labels[15:20, 15:20] = 0

    (surface,) = perception().project(labels, blank())["surfaces"]

    assert len(surface["polygon"]) == 4


def test_ground_beyond_range_and_above_horizon_is_dropped() -> None:
    """地平线 v = 200 px：x = 10 (u − 320) / (v − 200)，y = 1000 / (v − 200)。"""
    horizon = GroundMapping(
        homography=np.array([[10.0, 0, -3200], [0, 0, 1000], [0, 1, -200]]),
        reproj_error_m=0.0,
    )
    pose = {"x": 0.0, "y": 0.0, "range_m": 15.0}
    labels = grid(road=[(slice(0, GRID), slice(0, GRID))])

    (surface,) = perception(pose, horizon).project(labels, blank())["surfaces"]

    polygon = np.array(surface["polygon"])
    assert np.isfinite(polygon).all()
    assert np.hypot(polygon[:, 0], polygon[:, 1]).max() <= 15.0
    assert polygon[:, 1].min() == pytest.approx(1000 / (SIZE - 5 - 200), abs=0.01)  # 最低一行格中心


def test_polygons_capped_by_area() -> None:
    """每帧多边形合计不超过 64 个，保留面积最大的。"""
    blocks = [(slice(r, r + 5), slice(c, c + 5)) for r in range(0, 63, 7) for c in range(0, 63, 7)]
    labels = grid(road=blocks)  # 81 块，每块 0.16 m²
    labels[0:12, 0:12] = label("sidewalk")

    surfaces = perception().project(labels, blank())["surfaces"]

    assert len(surfaces) == MAX_POLYGONS
    assert "sidewalk" in {s["class"] for s in surfaces}


# --- 分割、平滑与无效帧 ---


class FakeSession:
    """左半边路面（logit 10），右半边各类相同（概率 1/150，低于阈值）。"""

    def get_inputs(self) -> list[SimpleNamespace]:
        return [SimpleNamespace(name="input")]

    def run(self, names: None, feed: dict[str, np.ndarray]) -> list[np.ndarray]:
        assert feed["input"].shape == (1, 3, 512, 512)
        logits = np.zeros((1, 150, GRID, GRID), np.float32)
        logits[0, 6, :, : GRID // 2] = 10  # ADE20K 6 = road
        return [logits]


def test_segmenter_maps_classes_and_drops_low_confidence_and_dark() -> None:
    frame = blank(128)
    frame[: SIZE // 4] = 10  # 上方 1/4 过暗

    labels = Segmenter(cast(Any, FakeSession()))(frame)

    assert (labels[GRID // 4 :, : GRID // 2] == label("road")).all()
    assert (labels[: GRID // 4] == 0).all()
    assert (labels[:, GRID // 2 :] == 0).all()


def test_single_change_does_not_flip_two_do() -> None:
    old, new = np.full((2, 2), 1), np.full((2, 2), 2)

    assert (smooth(deque([old, old, new])) == old).all()
    assert (smooth(deque([old, new, new])) == new).all()
    assert (smooth(deque([np.full((2, 2), 3), old, new])) == new).all()  # 各不相同取最新


class SequenceSegmenter:
    def __init__(self, *labels: np.ndarray) -> None:
        self._labels = list(labels)

    def __call__(self, frame: np.ndarray) -> np.ndarray:
        return self._labels.pop(0)


def test_process_publishes_smoothed_scene() -> None:
    road = grid(road=[(slice(10, 30), slice(10, 30))])
    grass = grid(grass=[(slice(10, 30), slice(10, 30))])
    camera = perception(segmenter=SequenceSegmenter(road, road, grass, grass))

    classes = []
    for _ in range(4):
        event = camera.process(blank())
        assert event is not None
        classes.append(event.surfaces[0].class_)

    assert classes == ["road", "road", "road", "grass"]  # 连续 2 次才翻转
    assert event.camera_id == "cam-01"


def test_nothing_recognized_is_not_published() -> None:
    """无有效识别时不发布：大屏保留上一帧，超过 10 s 未更新即标为陈旧（设计 §3.7）。"""
    camera = perception(segmenter=SequenceSegmenter(np.zeros((GRID, GRID), np.uint8)))

    assert camera.process(blank()) is None
