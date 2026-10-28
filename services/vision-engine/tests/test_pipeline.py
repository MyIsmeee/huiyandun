"""检测链路：门控 → 检测 → 跟踪 → track 事件。以假检测器与假总线代替模型和 NATS。"""

import asyncio
import importlib.util
from collections import Counter
from pathlib import Path
from typing import cast

import numpy as np
import pytest
import supervision as sv
from onnxruntime.datasets import get_example

from py_common.bus import Bus
from py_common.config import load_config
from py_contracts.events.hyd_vision_track_v1_schema import VisionTrackV1
from vision_engine.detector import PoseDetector
from vision_engine.geometry import GroundMapping
from vision_engine.pipeline import FPS, TRACK_SUBJECT, CameraPipeline, FrameReader, run_camera
from vision_engine.runtime import VisionConfig

# 正视地面：1 像素 = 1 cm
MAPPING = GroundMapping.fit([[u, v, u / 100, v / 100] for u in (0, 1000) for v in (0, 700)])


class FakeDetector:
    """每次调用返回一个人（框随调用次数右移 2 像素）；person=False 时返回空。"""

    def __init__(self, person: bool = True) -> None:
        self.person = person
        self.calls = 0

    def __call__(self, image: np.ndarray, offset: tuple[int, int] = (0, 0)) -> sv.Detections:
        x = 300 + 2 * self.calls
        self.calls += 1
        if not self.person:
            return sv.Detections.empty()
        return sv.Detections(xyxy=np.array([[x, 200.0, x + 100, 600]]), confidence=np.array([0.9]))


def frame(i: int) -> np.ndarray:
    image = np.zeros((720, 1280, 3), np.uint8)
    image[200:600, 300 + 2 * i : 400 + 2 * i] = 200  # 与假检测器的框一致，产生帧差
    return image


def pipeline(
    mapping: GroundMapping | None, person: bool = True
) -> tuple[CameraPipeline, FakeDetector]:
    fake = FakeDetector(person)
    return CameraPipeline("cam-01", mapping, cast(PoseDetector, fake)), fake


def test_tracks_published_with_floor_coordinates() -> None:
    camera, _ = pipeline(MAPPING)

    events = [e for i in range(4) for e in camera.process(frame(i), timestamp=i / FPS)]

    # 新轨迹须连续 2 帧确认，此后每帧一条
    assert len(events) == 3
    assert {e.track_id for e in events} == {events[0].track_id}
    last = events[-1]
    assert last.camera_id == "cam-01"
    # 第 4 帧框 [306, 200, 406, 600]：脚点 (356, 600) → (3.56 m, 6.0 m)；框高 400 → 偏移 20 像素
    assert (last.x, last.y) == pytest.approx((3.56, 6.0))
    assert last.uncertainty_m == pytest.approx(0.2)


def test_uncalibrated_camera_publishes_nothing() -> None:
    camera, fake = pipeline(None)

    events = [e for i in range(4) for e in camera.process(frame(i), timestamp=i / FPS)]

    assert events == []
    assert fake.calls == 4  # 仍检测与跟踪，只是不输出坐标（FR-902）


def test_static_scene_without_tracks_skips_detection() -> None:
    camera, fake = pipeline(MAPPING, person=False)
    empty = np.zeros((720, 1280, 3), np.uint8)

    for i in range(3):
        camera.process(empty, timestamp=i / FPS)

    assert fake.calls == 1  # 只有首帧整帧推理


def test_pyav_and_matplotlib_not_installed() -> None:
    """REUSE-07：PyAV 自带 GPL 的 x264 / x265（G-08）；跟踪在两者缺席时可用由上面的用例验证。"""
    assert importlib.util.find_spec("av") is None
    assert importlib.util.find_spec("matplotlib") is None


class FakeReader:
    """每次取用都有新帧，模拟 25 fps 的源。"""

    def __init__(self) -> None:
        self.seq = 0

    def latest(self) -> tuple[int, np.ndarray]:
        self.seq += 1
        return self.seq, frame(self.seq)


class FakeBus:
    def __init__(self) -> None:
        self.events: list[VisionTrackV1] = []

    async def publish(self, subject: str, event: VisionTrackV1) -> None:
        assert subject == TRACK_SUBJECT
        self.events.append(event)


def test_each_track_published_at_least_2_hz(tmp_path: Path) -> None:
    config = load_config(
        VisionConfig,
        {
            "HYD_DEVICE": "cpu",
            "HYD_MODEL_FILE": get_example("sigmoid.onnx"),
            "HYD_HEARTBEAT_FILE": str(tmp_path / "alive"),
        },
    )
    camera, _ = pipeline(MAPPING)
    bus = FakeBus()

    run = run_camera(camera, cast(FrameReader, FakeReader()), cast(Bus, bus), config)
    with pytest.raises(TimeoutError):
        asyncio.run(asyncio.wait_for(run, 3))

    per_track = Counter(e.track_id for e in bus.events)
    assert per_track and min(per_track.values()) / 3 >= 2  # FR-102：位置更新间隔 ≤ 500 ms
    assert (tmp_path / "alive").exists()
