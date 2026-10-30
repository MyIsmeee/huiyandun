"""检测链路：门控 → 检测 → 跟踪 → track 事件。以假检测器与假总线代替模型和 NATS。"""

import asyncio
import importlib.util
import logging
import threading
import time
from collections import Counter
from collections.abc import Callable
from pathlib import Path
from typing import cast

import nats
import numpy as np
import pytest
import supervision as sv

from py_common.bus import Bus
from py_contracts.events.hyd_vision_behavior_v1_schema import VisionBehaviorV1
from py_contracts.events.hyd_vision_track_v1_schema import VisionTrackV1
from vision_engine import pipeline as pipeline_module
from vision_engine.detector import PoseDetector, VehicleDetector
from vision_engine.geometry import GroundMapping
from vision_engine.pipeline import (
    BEHAVIOR_SUBJECT,
    FPS,
    TRACK_SUBJECT,
    VEHICLE_ID_BASE,
    CameraPipeline,
    FrameReader,
    Health,
    run_camera,
    supervise,
)

# 正视地面：1 像素 = 1 cm
MAPPING = GroundMapping.fit([[u, v, u / 100, v / 100] for u in (0, 1000) for v in (0, 700)])


class FakeDetector:
    """每次调用返回一个人（框随调用次数右移 2 像素）；person=False 时返回空。

    关键点：直立时肩、髋、膝、踝自上而下排在框的竖直中线上；lying=True 时全部位于框底、水平排开。
    """

    def __init__(self, person: bool = True, lying: bool = False) -> None:
        self.person = person
        self.lying = lying
        self.calls = 0

    def __call__(self, image: np.ndarray, offset: tuple[int, int] = (0, 0)) -> sv.Detections:
        x = 300 + 2 * self.calls
        self.calls += 1
        if not self.person:
            return sv.Detections.empty()
        keypoints = np.full((1, 17, 2), [x + 50.0, 400])
        for idx, (dx, y) in {(5, 6): (90, 260), (11, 12): (55, 400), (15, 16): (0, 600)}.items():
            keypoints[0, list(idx)] = (x + dx, 590) if self.lying else (x + 50, y)
        return sv.Detections(
            xyxy=np.array([[x, 200.0, x + 100, 600]]),
            confidence=np.array([0.9]),
            data={"keypoints": keypoints, "keypoint_scores": np.full((1, 17), 0.9)},
        )


def frame(i: int) -> np.ndarray:
    image = np.zeros((720, 1280, 3), np.uint8)
    image[200:600, 300 + 2 * i : 400 + 2 * i] = 200  # 与假检测器的框一致，产生帧差
    return image


def pipeline(
    mapping: GroundMapping | None, person: bool = True, lying: bool = False
) -> tuple[CameraPipeline, FakeDetector]:
    fake = FakeDetector(person, lying)
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
    # 画面叠加用的归一化框与骨骼（FR-107）：1280×720 画面
    sent = last.model_dump(mode="json")
    assert sent["object_class"] == "person"
    assert sent["bbox"] == pytest.approx([306 / 1280, 200 / 720, 406 / 1280, 600 / 720])
    assert len(sent["keypoints"]) == 17
    assert sent["keypoints"][15] == pytest.approx([356 / 1280, 600 / 720, 0.9])


class FakeVehicles:
    """一辆轿车，每次检测向右移动 20 像素（MAPPING 下即 0.2 m）。"""

    def __init__(self) -> None:
        self.calls = 0
        self.class_id = 2  # COCO car

    def __call__(self, image: np.ndarray, offset: tuple[int, int] = (0, 0)) -> sv.Detections:
        x = 200 + 20 * self.calls
        self.calls += 1
        return sv.Detections(
            xyxy=np.array([[x, 300.0, x + 200, 500]]),
            confidence=np.array([0.9]),
            class_id=np.array([self.class_id]),
        )


def test_vehicles_tracked_with_heading_and_speed() -> None:
    """画面中只有车辆（无人员）：车辆轨迹编号与人员分开，无骨骼，朝向与速度由轨迹得出。"""
    camera = CameraPipeline(
        "cam-01", MAPPING, cast(PoseDetector, FakeDetector(person=False)),
        vehicles=cast(VehicleDetector, FakeVehicles()),
    )  # fmt: skip

    events = [e for i in range(6) for e in camera.process(frame(i), timestamp=i / FPS)]

    assert len(events) == 5  # 新轨迹须连续 2 帧确认
    assert all(isinstance(e, VisionTrackV1) and e.object_class == "car" for e in events)
    assert all(e.track_id >= VEHICLE_ID_BASE and e.keypoints is None for e in events)
    first, last = events[0].model_dump(), events[-1].model_dump()
    assert (first["heading_deg"], first["speed_mps"]) == (None, None)  # 不足 3 帧
    # 每 0.2 s 向 +x 移动 0.2 m
    assert (last["heading_deg"], last["speed_mps"]) == pytest.approx((0, 1.0))


def test_vehicle_class_is_majority_over_track() -> None:
    """同一辆两轮车逐帧在自行车与摩托车之间跳变时，按轨迹内多数类别输出，模型不闪烁。"""
    fake = FakeVehicles()
    camera = CameraPipeline(
        "cam-01", MAPPING, cast(PoseDetector, FakeDetector(person=False)),
        vehicles=cast(VehicleDetector, fake),
    )  # fmt: skip
    classes = []
    for i, coco in enumerate([1, 1, 1, 3, 1, 3]):  # 1 bicycle，3 motorcycle
        fake.class_id = coco
        classes += [e.object_class for e in camera.process(frame(i), timestamp=i / FPS)]

    assert classes == ["bicycle"] * 5


def test_fall_detected_on_uncalibrated_camera() -> None:
    """未标定摄像头不输出坐标，但仍输出设备级行为告警（C-CV-05）。"""
    camera, _ = pipeline(None, lying=True)

    events = [e for i in range(15) for e in camera.process(frame(i), timestamp=i / FPS)]

    [fall] = events
    assert isinstance(fall, VisionBehaviorV1)
    assert (fall.camera_id, fall.behavior, fall.confidence_avg) == ("cam-01", "fall", 0.9)
    assert fall.duration_s == pytest.approx(2.0)
    assert (fall.ts_end - fall.ts_start).total_seconds() == pytest.approx(2.0)


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
    """js_publish 记录后按超时失败：模拟 NATS 不可用。"""

    def __init__(self) -> None:
        self.events: list[VisionTrackV1] = []
        self.behaviors: list[VisionBehaviorV1] = []

    async def publish(self, subject: str, event: VisionTrackV1) -> None:
        assert subject == TRACK_SUBJECT
        self.events.append(event)

    async def js_publish(self, subject: str, event: VisionBehaviorV1) -> None:
        assert subject == BEHAVIOR_SUBJECT
        self.behaviors.append(event)
        raise nats.errors.TimeoutError


def run_for(camera: CameraPipeline, bus: FakeBus, seconds: float) -> int:
    """运行检测循环，返回完成的周期数。"""
    beats = 0

    def beat() -> None:
        nonlocal beats
        beats += 1

    run = run_camera(camera, cast(FrameReader, FakeReader()), cast(Bus, bus), beat)
    with pytest.raises(TimeoutError):
        asyncio.run(asyncio.wait_for(run, seconds))
    return beats


def test_each_track_published_at_least_2_hz() -> None:
    camera, _ = pipeline(MAPPING)
    bus = FakeBus()

    beats = run_for(camera, bus, 3)

    per_track = Counter(e.track_id for e in bus.events)
    assert per_track and min(per_track.values()) / 3 >= 2  # FR-102：位置更新间隔 ≤ 500 ms
    assert beats >= 3 * FPS - 1  # 每个周期登记一次健康


def test_behavior_publish_failure_is_logged_and_detection_continues(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """行为事件经 JetStream 持久化（HYD-PLAN-007 §2）；发布失败记录错误，位置照常发布。"""
    camera, _ = pipeline(MAPPING, lying=True)
    bus = FakeBus()

    with caplog.at_level(logging.ERROR):
        run_for(camera, bus, 3.5)

    assert [b.behavior for b in bus.behaviors] == ["fall"]
    failed = [r for r in caplog.records if r.getMessage() == "vision.behavior_publish_failed"]
    assert len(failed) == 1
    assert bus.events[-1].ts > bus.behaviors[0].ts


def test_failed_loop_is_logged_and_retried_without_stopping_others(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture, tmp_path: Path
) -> None:
    """#79：单路循环异常只重试该路，其他路照常运行。"""
    monkeypatch.setattr(pipeline_module, "RECONNECT_S", 0.05)
    health = Health(tmp_path / "alive")
    attempts = 0
    other_beats = 0

    async def broken(beat: object) -> None:
        nonlocal attempts
        attempts += 1
        raise RuntimeError("推理失败")

    async def healthy(beat: object) -> None:
        nonlocal other_beats
        while True:
            other_beats += 1
            await asyncio.sleep(0.01)

    async def main() -> None:
        await asyncio.gather(
            supervise("cam-01/detect", broken, health), supervise("cam-02/detect", healthy, health)
        )

    with caplog.at_level(logging.ERROR), pytest.raises(TimeoutError):
        asyncio.run(asyncio.wait_for(main(), 0.5))

    assert attempts >= 3
    assert other_beats >= 20
    failed = [r for r in caplog.records if r.getMessage() == "vision.loop_failed"]
    assert failed and failed[0].loop == "cam-01/detect"


def test_persistently_failing_loop_does_not_exit_process(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """#79：一路持续报错时只在该路重试，不判为停滞、不退出进程，另一路照常运行。"""
    monkeypatch.setattr(pipeline_module, "RECONNECT_S", 0.05)
    monkeypatch.setattr(pipeline_module, "STALL_S", 0.2)

    def exit_(code: int) -> None:
        raise SystemExit(code)

    monkeypatch.setattr(pipeline_module.os, "_exit", exit_)
    health = Health(tmp_path / "alive")
    other_beats = 0

    async def broken(beat: Callable[[], None]) -> None:
        raise RuntimeError("推理失败")

    async def healthy(beat: Callable[[], None]) -> None:
        nonlocal other_beats
        while True:
            other_beats += 1
            beat()
            await asyncio.sleep(0.01)

    async def main() -> None:
        await asyncio.gather(
            health.run(),
            supervise("cam-01/detect", broken, health),
            supervise("cam-02/detect", healthy, health),
        )

    with pytest.raises(TimeoutError):
        asyncio.run(asyncio.wait_for(main(), 2.5))  # 心跳每秒检查一次，覆盖两次检查

    assert other_beats >= 100
    assert (tmp_path / "alive").exists()


def test_heartbeat_updated_while_all_loops_progress(tmp_path: Path) -> None:
    health = Health(tmp_path / "alive")
    health.beat("cam-01/detect")
    health.beat("cam-01/reader")

    with pytest.raises(TimeoutError):
        asyncio.run(asyncio.wait_for(health.run(), 0.1))

    assert (tmp_path / "alive").exists()


def test_stalled_loop_exits_process(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture, tmp_path: Path
) -> None:
    """#79：任一循环或读帧线程超过 STALL_S 未登记即退出进程，由 Compose 拉起；不更新心跳文件。"""
    monkeypatch.setattr(pipeline_module, "STALL_S", 0.2)

    def exit_(code: int) -> None:
        raise SystemExit(code)

    monkeypatch.setattr(pipeline_module.os, "_exit", exit_)
    health = Health(tmp_path / "alive")
    health.beat("cam-01/detect")
    health.beat("cam-01/reader")
    time.sleep(0.3)
    health.beat("cam-01/detect")

    with caplog.at_level(logging.ERROR), pytest.raises(SystemExit) as exited:
        asyncio.run(health.run())

    assert exited.value.code == 1
    stalled = [r for r in caplog.records if r.getMessage() == "vision.stalled"]
    assert stalled and stalled[0].loops == ["cam-01/reader"]
    assert not (tmp_path / "alive").exists()


def test_reader_survives_capture_exception(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """#79：读帧异常记录后按断流重连，读帧线程不退出；每次建连登记一次健康。"""
    monkeypatch.setattr(pipeline_module, "RECONNECT_S", 0.01)
    calls = 0
    beats = []
    done = threading.Event()

    def capture(*args: object) -> object:
        nonlocal calls
        calls += 1
        if calls > 2:
            done.set()
            threading.Event().wait()  # 之后一直阻塞：测试结束后线程不再连真实地址
        raise pipeline_module.cv2.error("模拟解码器异常")

    monkeypatch.setattr(pipeline_module.cv2, "VideoCapture", capture)
    reader = FrameReader("cam-01", "rtsp://go2rtc:8554/cam-01", lambda: beats.append(1))
    with caplog.at_level(logging.ERROR):
        reader.start()
        assert done.wait(2)

    assert reader.is_alive()
    assert len(beats) == 3
    assert any(r.getMessage() == "vision.reader_failed" for r in caplog.records)


def test_reader_beats_on_connect_and_every_frame(monkeypatch: pytest.MonkeyPatch) -> None:
    """#79：读帧线程建连前后与每读到一帧都登记一次健康，卡在读帧调用中即停滞。"""
    monkeypatch.setattr(pipeline_module, "RECONNECT_S", 0.01)
    beats = []
    done = threading.Event()

    class Capture:
        def __init__(self) -> None:
            self.frames = 2

        def read(self) -> tuple[bool, np.ndarray | None]:
            if self.frames:
                self.frames -= 1
                return True, frame(0)
            return False, None

        def release(self) -> None:
            pass

    calls = 0

    def capture(*args: object) -> Capture:
        nonlocal calls
        calls += 1
        if calls > 1:
            done.set()
            threading.Event().wait()  # 第二次建连起一直阻塞：测试结束后线程不再连真实地址
        return Capture()

    monkeypatch.setattr(pipeline_module.cv2, "VideoCapture", capture)
    reader = FrameReader("cam-01", "rtsp://go2rtc:8554/cam-01", lambda: beats.append(1))
    reader.start()
    assert done.wait(2)

    # 第一次：建连前、建连后、两帧各一次；第二次：建连前一次
    assert len(beats) == 5
    assert reader.latest() is not None and reader.latest()[0] == 2
