"""RTMO 输出换算：模型输入坐标 → 裁剪区域 → 整帧坐标；低分框丢弃。以假会话代替模型。"""

import importlib.util
from types import SimpleNamespace
from typing import cast

import numpy as np
import onnxruntime as ort
from onnxruntime.datasets import get_example

from vision_engine.detector import PoseDetector


class FakeSession:
    """按 RTMO 导出模型的输出格式返回 dets (1, N, 5) 与 keypoints (1, N, 17, 3)。"""

    def __init__(self, dets: list[list[float]]) -> None:
        self.dets = np.array([dets], np.float32)
        keypoints = np.zeros((1, len(dets), 17, 3), np.float32)
        keypoints[0, :, :, 0], keypoints[0, :, :, 1], keypoints[0, :, :, 2] = 150, 250, 0.8
        self.keypoints = keypoints

    def get_inputs(self) -> list[SimpleNamespace]:
        return [SimpleNamespace(name="input")]

    def get_outputs(self) -> list[SimpleNamespace]:
        return [SimpleNamespace(name="dets"), SimpleNamespace(name="keypoints")]

    def run(self, names: list[str], feed: dict[str, np.ndarray]) -> list[np.ndarray]:
        assert feed["input"].shape == (1, 3, 640, 640)
        return [self.dets, self.keypoints]


def detector(dets: list[list[float]]) -> PoseDetector:
    return PoseDetector(get_example("sigmoid.onnx"), cast(ort.InferenceSession, FakeSession(dets)))


def test_maps_to_full_frame() -> None:
    # 1280×720 的裁剪区域缩放为 0.5 送入模型；区域左上角位于整帧 (100, 40)
    image = np.zeros((720, 1280, 3), np.uint8)

    result = detector([[100, 100, 200, 300, 0.9], [400, 100, 450, 200, 0.1]])(image, (100, 40))

    assert len(result) == 1  # 低分框丢弃
    assert result.xyxy[0].tolist() == [300, 240, 500, 640]
    assert result.confidence is not None
    assert result.confidence[0] == np.float32(0.9)
    assert result.data["keypoints"].shape == (1, 17, 2)
    assert result.data["keypoints"][0, 0].tolist() == [400, 540]
    assert result.data["keypoint_scores"][0, 0] == np.float32(0.8)


def test_no_person() -> None:
    result = detector([[100, 100, 200, 300, 0.1]])(np.zeros((720, 1280, 3), np.uint8))

    assert len(result) == 0


def test_pyav_and_matplotlib_not_installed() -> None:
    """REUSE-07：supervision 声明但不需要；PyAV 自带 GPL 的 x264 / x265，不得进程内加载（G-08）。"""
    assert importlib.util.find_spec("av") is None
    assert importlib.util.find_spec("matplotlib") is None
