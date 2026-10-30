"""检测链路（TK-021、TK-022、TK-118）：go2rtc 拉流 → 运动门控 → RTMO → ByteTrack →
hyd.vision.track.v1 与 hyd.vision.behavior.v1；已标定摄像头另以 1 FPS 分割环境 → hyd.vision.scene.v1。

每路摄像头一个读帧线程，持续解码以跟上源帧率、只保留最新一帧；检测按固定 5 FPS 取用最新帧，
处理慢时丢帧而不积压延迟。只经 go2rtc 取流，不直连摄像头（C-CV-10）。

各路相互隔离（#79）：单路循环异常只重试该路；健康检查按路判断，任一路停滞即 unhealthy。
"""

import asyncio
import logging
import sys
import threading
import time
import uuid
from collections import Counter
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime, timedelta
from functools import partial
from pathlib import Path

import cv2
import nats
import numpy as np
import supervision as sv
import yaml
from trackers import ByteTrackTracker

from py_common.bus import Bus
from py_common.config import load_config
from py_common.log import configure_logging
from py_contracts.config.site_schema import SiteConfig
from py_contracts.events.hyd_vision_behavior_v1_schema import VisionBehaviorV1
from py_contracts.events.hyd_vision_track_v1_schema import VisionTrackV1
from vision_engine.behavior import BehaviorDetector
from vision_engine.detector import VEHICLES, PoseDetector, VehicleDetector
from vision_engine.geometry import GroundMapping
from vision_engine.kinematics import Motion
from vision_engine.motion import MotionGate
from vision_engine.runtime import DeviceError, VisionConfig, create_session, model_files
from vision_engine.scene import ScenePerception, Segmenter

FPS = 5  # 固定检测帧率（FR-101、C-CV-08），与模型卡一致
TRACK_SUBJECT = "hyd.vision.track.v1"
BEHAVIOR_SUBJECT = "hyd.vision.behavior.v1"
SCENE_SUBJECT = "hyd.vision.scene.v1"  # 核心 NATS，不持久化
SCENE_FPS = 1  # 环境变化慢，每台摄像头每秒识别 1 次（FR-108）
# 持久化的视觉事件（HYD-PLAN-007 §2）；integrity 由 TK-114 发布。
# 保留期取检测事件的默认值 180 天（HYD-ARCH-001 §10.2）
STREAM = "HYD_VISION"
STREAM_SUBJECTS = [BEHAVIOR_SUBJECT, "hyd.vision.integrity.v1"]
STREAM_MAX_AGE_S = 180 * 86400
SCHEMA_VERSION = "1.0.0"
TRACK_SCHEMA_VERSION = "1.1.0"  # 1.1：类别、朝向、速度、画面框与骨骼（HYD-PLAN-007 v1.9）
TIMEOUT_MS = 5000  # 拉流的建连与读帧超时（CD-04）
RECONNECT_S = 2.0  # 断流重连与单路循环异常后重试的间隔
STALL_S = 10.0  # 任一循环超过此时长未完成周期即视为停滞，与 compose 健康检查的阈值一致
# 新轨迹须连续 2 帧、置信度 ≥ 0.5；RTMO 对远处行人的置信度多在 0.5～0.6（模型卡）
TRACK_ACTIVATION = 0.5
# 车辆与人员分别跟踪（骑车人与自行车框重叠，混合跟踪会互换编号）；车辆轨迹编号加此偏移，同一路内不重复
VEHICLE_ID_BASE = 1_000_000

log = logging.getLogger(__name__)


class FrameReader(threading.Thread):
    def __init__(self, camera_id: str, url: str) -> None:
        super().__init__(name=f"reader-{camera_id}", daemon=True)
        self._camera_id = camera_id
        self._url = url
        self._lock = threading.Lock()
        self._latest: tuple[int, np.ndarray] | None = None

    def latest(self) -> tuple[int, np.ndarray] | None:
        """(序号, 帧)；序号不变表示没有新帧（如断流期间）。"""
        with self._lock:
            return self._latest

    def run(self) -> None:
        seq, lost = 0, False
        while True:
            try:
                capture = cv2.VideoCapture(
                    self._url,
                    cv2.CAP_FFMPEG,
                    [
                        cv2.CAP_PROP_OPEN_TIMEOUT_MSEC,
                        TIMEOUT_MS,
                        cv2.CAP_PROP_READ_TIMEOUT_MSEC,
                        TIMEOUT_MS,
                    ],
                )
                while True:
                    ok, frame = capture.read()
                    if not ok:
                        break
                    if lost:
                        log.info("vision.stream_restored", extra={"camera_id": self._camera_id})
                        lost = False
                    seq += 1
                    with self._lock:
                        self._latest = (seq, frame)
                capture.release()
            except cv2.error:
                # 解码器异常按断流处理并重连，读帧线程不退出（#79）
                log.exception("vision.reader_failed", extra={"camera_id": self._camera_id})
            if not lost:
                # 不静默跳过（C-CV-09）；stream_lost 事件由 TK-114 发布
                log.warning("vision.stream_lost", extra={"camera_id": self._camera_id})
                lost = True
            threading.Event().wait(RECONNECT_S)


class CameraPipeline:
    """单路的门控、检测与跟踪；状态只在本路串行调用的 process 中使用。"""

    def __init__(
        self,
        camera_id: str,
        mapping: GroundMapping | None,
        detector: PoseDetector,
        climb_lines: list[list[float]] | None = None,
        vehicles: VehicleDetector | None = None,
    ) -> None:
        self._camera_id = camera_id
        self._mapping = mapping
        self._detector = detector
        self._vehicles = vehicles  # None 时只检测人员（如关键点录制工具）
        self._behaviors = BehaviorDetector(climb_lines or [])
        self._gate = MotionGate()
        self._tracker, self._vehicle_tracker = (
            ByteTrackTracker(
                frame_rate=FPS,
                track_activation_threshold=TRACK_ACTIVATION,
                high_conf_det_threshold=TRACK_ACTIVATION,
            )
            for _ in range(2)
        )
        self._motion = Motion()
        self._votes: dict[int, Counter[int]] = {}  # 车辆轨迹 → 各帧检出类别的计数
        self._boxes = np.empty((0, 4))

    def track(self, frame: np.ndarray, timestamp: float) -> tuple[sv.Detections, sv.Detections]:
        """门控、检测与跟踪，返回已确认的人员轨迹（含关键点）与车辆轨迹；无运动且无轨迹时为空。"""
        region = self._gate.region(frame, self._boxes)
        if region is None:
            return sv.Detections.empty(), sv.Detections.empty()
        x1, y1, x2, y2 = region
        crop = frame[y1:y2, x1:x2]
        people = self._confirmed(self._tracker, self._detector(crop, offset=(x1, y1)), timestamp)
        vehicles = (
            self._confirmed(self._vehicle_tracker, self._vehicles(crop, offset=(x1, y1)), timestamp)
            if self._vehicles is not None
            else sv.Detections.empty()
        )
        self._boxes = np.concatenate([people.xyxy, vehicles.xyxy])
        return people, vehicles

    def _vote(self, track_id: int, class_id: int) -> int:
        """轨迹内多数类别：两轮车常在自行车与摩托车之间逐帧跳变，按多数输出，大屏模型不闪烁。"""
        votes = self._votes.setdefault(int(track_id), Counter())
        votes[int(class_id)] += 1
        return votes.most_common(1)[0][0]

    @staticmethod
    def _confirmed(
        tracker: ByteTrackTracker, detections: sv.Detections, timestamp: float
    ) -> sv.Detections:
        tracked = tracker.update(detections, timestamp=timestamp)
        return tracked[tracked.tracker_id >= 0]  # -1 为尚未确认的轨迹

    def process(
        self, frame: np.ndarray, timestamp: float
    ) -> list[VisionTrackV1 | VisionBehaviorV1]:
        tracked, vehicles = self.track(frame, timestamp)
        if not len(tracked) and not len(vehicles):
            return []
        now = datetime.now(UTC)
        # 未标定摄像头同样判定行为：只输出设备级告警（C-CV-05）
        events: list[VisionTrackV1 | VisionBehaviorV1] = [
            VisionBehaviorV1(
                schema_version=SCHEMA_VERSION,
                event_id=uuid.uuid4(),
                ts=now,
                camera_id=self._camera_id,
                track_id=b.track_id,
                behavior=b.behavior,
                confidence_avg=b.confidence_avg,
                duration_s=b.end - b.start,
                ts_start=now - timedelta(seconds=b.end - b.start),
                ts_end=now,
            )
            for b in (
                self._behaviors.update(
                    tracked.tracker_id,
                    tracked.data["keypoints"],
                    tracked.data["keypoint_scores"],
                    timestamp,
                )
                if len(tracked)  # 空结果不含关键点数据
                else []
            )
        ]
        if self._mapping is None:
            return events  # 未标定不输出坐标（FR-902）
        height, width = frame.shape[:2]
        scale = np.array([width, height], dtype=np.float32)
        targets = [
            (int(i), "person", box, np.column_stack([points / scale, scores]))
            for box, i, points, scores in (
                zip(
                    tracked.xyxy,
                    tracked.tracker_id,
                    tracked.data["keypoints"],
                    tracked.data["keypoint_scores"],
                    strict=True,
                )
                if len(tracked)
                else []
            )
        ] + [
            (VEHICLE_ID_BASE + i, VEHICLES[self._vote(i, c)], box, None)
            for box, i, c in (
                zip(vehicles.xyxy, vehicles.tracker_id, vehicles.class_id, strict=True)
                if len(vehicles)
                else []
            )
        ]
        current = set(vehicles.tracker_id.tolist()) if len(vehicles) else set()
        self._votes = {i: v for i, v in self._votes.items() if i in current}
        for track_id, object_class, (bx1, by1, bx2, by2), keypoints in targets:
            # 脚点（车辆为接地点）取框底边中点
            located = self._mapping.locate((bx1 + bx2) / 2, by2, by2 - by1)
            if located is None:
                continue
            x, y, uncertainty = located
            heading, speed = self._motion.update(track_id, timestamp, x, y)
            events.append(
                VisionTrackV1(
                    schema_version=TRACK_SCHEMA_VERSION,
                    event_id=uuid.uuid4(),
                    ts=now,
                    camera_id=self._camera_id,
                    track_id=track_id,
                    object_class=object_class,
                    x=x,
                    y=y,
                    uncertainty_m=uncertainty,
                    heading_deg=heading,
                    speed_mps=speed,
                    bbox=np.clip(
                        [bx1 / width, by1 / height, bx2 / width, by2 / height], 0, 1
                    ).tolist(),
                    keypoints=None if keypoints is None else np.clip(keypoints, 0, 1).tolist(),
                )
            )
        return events


class Health:
    """按路判断健康（#79）：各循环每完成一个周期登记一次；全部循环在 STALL_S 内有登记、
    且全部读帧线程存活时才更新心跳文件，任一路停滞即由健康检查判为 unhealthy。"""

    def __init__(self, heartbeat_file: Path) -> None:
        self._file = heartbeat_file
        self._beats: dict[str, float] = {}
        self._readers: list[threading.Thread] = []

    def watch(self, reader: threading.Thread) -> None:
        self._readers.append(reader)

    def beat(self, name: str) -> None:
        self._beats[name] = time.monotonic()

    def healthy(self) -> bool:
        now = time.monotonic()
        return all(now - t <= STALL_S for t in self._beats.values()) and all(
            r.is_alive() for r in self._readers
        )

    async def run(self) -> None:
        while True:
            if self.healthy():
                self._file.touch()
            await asyncio.sleep(1)


async def supervise(
    name: str, run: Callable[[Callable[[], None]], Awaitable[None]], health: Health
) -> None:
    """运行一路循环；异常时记录并在 RECONNECT_S 后重试，不影响其他路（#79）。"""
    health.beat(name)  # 从未完成周期的循环同样计入停滞判断
    while True:
        try:
            await run(partial(health.beat, name))
        except Exception:
            log.exception("vision.loop_failed", extra={"loop": name})
            await asyncio.sleep(RECONNECT_S)


async def run_camera(
    pipeline: CameraPipeline, reader: FrameReader, bus: Bus, beat: Callable[[], None]
) -> None:
    loop = asyncio.get_running_loop()
    next_tick, last_seq = loop.time(), 0
    while True:
        next_tick = max(next_tick + 1 / FPS, loop.time())  # 处理超时后不补跑积压的周期
        await asyncio.sleep(next_tick - loop.time())
        latest = reader.latest()
        if latest is not None and latest[0] != last_seq:
            last_seq, frame = latest
            events = await asyncio.to_thread(pipeline.process, frame, time.monotonic())
            for event in events:
                if isinstance(event, VisionTrackV1):
                    await bus.publish(TRACK_SUBJECT, event)
                    continue
                try:
                    await bus.js_publish(BEHAVIOR_SUBJECT, event)
                except (nats.errors.Error, TimeoutError):
                    # 记录后继续检测：持续满足的行为 30 s 后重发（C-CV-09 不静默）
                    log.exception(
                        "vision.behavior_publish_failed", extra={"event_id": str(event.event_id)}
                    )
        beat()


async def run_scene(
    perception: ScenePerception, reader: FrameReader, bus: Bus, beat: Callable[[], None]
) -> None:
    loop = asyncio.get_running_loop()
    next_tick, last_seq = loop.time(), 0
    while True:
        next_tick = max(next_tick + 1 / SCENE_FPS, loop.time())
        await asyncio.sleep(next_tick - loop.time())
        latest = reader.latest()
        # 断流时不发布：大屏保留最后一帧（设计 §3.7）
        if latest is not None and latest[0] != last_seq:
            last_seq, frame = latest
            event = await asyncio.to_thread(perception.process, frame)
            if event is not None:
                await bus.publish(SCENE_SUBJECT, event)
        beat()


async def serve(config: VisionConfig) -> None:
    models = len(model_files(config))  # 显存上限由加载的模型平分（C-HW-12）
    detector = PoseDetector(
        str(config.model_file), create_session(config, config.model_file, models)
    )
    vehicles = (
        VehicleDetector(
            str(config.vehicle_model_file),
            create_session(config, config.vehicle_model_file, models),
        )
        if config.vehicle_model_file
        else None
    )
    segmenter = (
        Segmenter(create_session(config, config.scene_model_file, models))
        if config.scene_model_file
        else None
    )
    if vehicles is None:
        log.warning("vision.vehicles_disabled")  # 未配置 HYD_VEHICLE_MODEL_FILE
    if segmenter is None:
        log.warning("vision.scene_disabled")  # 未配置 HYD_SCENE_MODEL_FILE
    site = SiteConfig.model_validate(yaml.safe_load(config.site_file.read_text(encoding="utf-8")))
    bus = await Bus.connect(config.nats_url, name="vision-engine", timeout_s=config.nats_timeout_s)
    await bus.ensure_stream(STREAM, STREAM_SUBJECTS, STREAM_MAX_AGE_S)
    health = Health(config.heartbeat_file)
    runs = []
    for camera in site.model_dump(mode="json")["cameras"]:
        mapping = GroundMapping.fit(camera["calibration"])
        if mapping is None:
            log.warning("vision.uncalibrated", extra={"camera_id": camera["id"]})
        reader = FrameReader(camera["id"], f"{config.go2rtc_rtsp}/{camera['stream']}")
        reader.start()
        health.watch(reader)
        if mapping is not None and segmenter is not None:
            perception = ScenePerception(camera["id"], mapping, camera["pose"], segmenter)
            runs.append(
                supervise(
                    f"{camera['id']}/scene", partial(run_scene, perception, reader, bus), health
                )
            )
        detection = CameraPipeline(camera["id"], mapping, detector, camera["climb_lines"], vehicles)
        runs.append(
            supervise(f"{camera['id']}/detect", partial(run_camera, detection, reader, bus), health)
        )
    log.info("vision.started", extra={"device": config.device, "cameras": len(site.cameras)})
    await asyncio.gather(health.run(), *runs)


def main() -> None:
    """hyd-vision：常驻检测。声明 cuda 而未生效时以 1 退出（C-CV-11）。"""
    config = load_config(VisionConfig)
    configure_logging("vision-engine", config.log_level)
    try:
        asyncio.run(serve(config))
    except DeviceError as e:
        log.error("vision.device_unavailable", extra={"error": str(e)})
        sys.exit(1)
