"""检测链路（TK-021、TK-022）：go2rtc 拉流 → 运动门控 → RTMO → ByteTrack →
hyd.vision.track.v1 与 hyd.vision.behavior.v1。

每路摄像头一个读帧线程，持续解码以跟上源帧率、只保留最新一帧；检测按固定 5 FPS 取用最新帧，
处理慢时丢帧而不积压延迟。只经 go2rtc 取流，不直连摄像头（C-CV-10）。
"""

import asyncio
import logging
import sys
import threading
import time
import uuid
from datetime import UTC, datetime, timedelta

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
from vision_engine.detector import PoseDetector
from vision_engine.geometry import GroundMapping
from vision_engine.motion import MotionGate
from vision_engine.runtime import DeviceError, VisionConfig, create_session

FPS = 5  # 固定检测帧率（FR-101、C-CV-08），与模型卡一致
TRACK_SUBJECT = "hyd.vision.track.v1"
BEHAVIOR_SUBJECT = "hyd.vision.behavior.v1"
# 持久化的视觉事件（HYD-PLAN-007 §2）；integrity 由 TK-040 发布。
# 保留期取检测事件的默认值 180 天（HYD-ARCH-001 §10.2）
STREAM = "HYD_VISION"
STREAM_SUBJECTS = [BEHAVIOR_SUBJECT, "hyd.vision.integrity.v1"]
STREAM_MAX_AGE_S = 180 * 86400
SCHEMA_VERSION = "1.0.0"
TRACK_SCHEMA_VERSION = "1.1.0"  # 1.1：类别、朝向、速度、画面框与骨骼（HYD-PLAN-007 v1.9）
TIMEOUT_MS = 5000  # 拉流的建连与读帧超时（CD-04）
RECONNECT_S = 2.0
# 新轨迹须连续 2 帧、置信度 ≥ 0.5；RTMO 对远处行人的置信度多在 0.5～0.6（模型卡）
TRACK_ACTIVATION = 0.5

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
            if not lost:
                # 不静默跳过（C-CV-09）；stream_lost 事件由 TK-040 发布
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
    ) -> None:
        self._camera_id = camera_id
        self._mapping = mapping
        self._detector = detector
        self._behaviors = BehaviorDetector(climb_lines or [])
        self._gate = MotionGate()
        self._tracker = ByteTrackTracker(
            frame_rate=FPS,
            track_activation_threshold=TRACK_ACTIVATION,
            high_conf_det_threshold=TRACK_ACTIVATION,
        )
        self._boxes = np.empty((0, 4))

    def track(self, frame: np.ndarray, timestamp: float) -> sv.Detections:
        """门控、检测与跟踪，返回已确认的轨迹（含关键点）；无运动且无轨迹时为空。"""
        region = self._gate.region(frame, self._boxes)
        if region is None:
            return sv.Detections.empty()
        x1, y1, x2, y2 = region
        detections = self._detector(frame[y1:y2, x1:x2], offset=(x1, y1))
        tracked = self._tracker.update(detections, timestamp=timestamp)
        tracked = tracked[tracked.tracker_id >= 0]  # -1 为尚未确认的轨迹
        self._boxes = tracked.xyxy
        return tracked

    def process(
        self, frame: np.ndarray, timestamp: float
    ) -> list[VisionTrackV1 | VisionBehaviorV1]:
        tracked = self.track(frame, timestamp)
        if not len(tracked):
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
            for b in self._behaviors.update(
                tracked.tracker_id,
                tracked.data["keypoints"],
                tracked.data["keypoint_scores"],
                timestamp,
            )
        ]
        if self._mapping is None:
            return events  # 未标定不输出坐标（FR-902）
        height, width = frame.shape[:2]
        scale = np.array([width, height], dtype=np.float32)
        for (bx1, by1, bx2, by2), track_id, keypoints, scores in zip(
            tracked.xyxy,
            tracked.tracker_id,
            tracked.data["keypoints"],
            tracked.data["keypoint_scores"],
            strict=True,
        ):
            # 脚点取人体框底边中点
            located = self._mapping.locate((bx1 + bx2) / 2, by2, by2 - by1)
            if located is None:
                continue
            x, y, uncertainty = located
            events.append(
                VisionTrackV1(
                    schema_version=TRACK_SCHEMA_VERSION,
                    event_id=uuid.uuid4(),
                    ts=now,
                    camera_id=self._camera_id,
                    track_id=int(track_id),
                    object_class="person",
                    x=x,
                    y=y,
                    uncertainty_m=uncertainty,
                    heading_deg=None,  # 由 TK-111 按轨迹计算
                    speed_mps=None,
                    bbox=np.clip(
                        [bx1 / width, by1 / height, bx2 / width, by2 / height], 0, 1
                    ).tolist(),
                    keypoints=np.clip(np.column_stack([keypoints / scale, scores]), 0, 1).tolist(),
                )
            )
        return events


async def run_camera(
    pipeline: CameraPipeline, reader: FrameReader, bus: Bus, config: VisionConfig
) -> None:
    loop = asyncio.get_running_loop()
    next_tick, last_seq = loop.time(), 0
    while True:
        next_tick = max(next_tick + 1 / FPS, loop.time())  # 处理超时后不补跑积压的周期
        await asyncio.sleep(next_tick - loop.time())
        config.heartbeat_file.touch()
        latest = reader.latest()
        if latest is None or latest[0] == last_seq:
            continue
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


async def serve(config: VisionConfig) -> None:
    detector = PoseDetector(str(config.model_file), create_session(config))
    site = SiteConfig.model_validate(yaml.safe_load(config.site_file.read_text(encoding="utf-8")))
    bus = await Bus.connect(config.nats_url, name="vision-engine", timeout_s=config.nats_timeout_s)
    await bus.ensure_stream(STREAM, STREAM_SUBJECTS, STREAM_MAX_AGE_S)
    runs = []
    for camera in site.model_dump(mode="json")["cameras"]:
        mapping = GroundMapping.fit(camera["calibration"])
        if mapping is None:
            log.warning("vision.uncalibrated", extra={"camera_id": camera["id"]})
        reader = FrameReader(camera["id"], f"{config.go2rtc_rtsp}/{camera['stream']}")
        reader.start()
        runs.append(
            run_camera(
                CameraPipeline(camera["id"], mapping, detector, camera["climb_lines"]),
                reader,
                bus,
                config,
            )
        )
    log.info("vision.started", extra={"device": config.device, "cameras": len(runs)})
    await asyncio.gather(*runs)


def main() -> None:
    """hyd-vision：常驻检测。声明 cuda 而未生效时以 1 退出（C-CV-11）。"""
    config = load_config(VisionConfig)
    configure_logging("vision-engine", config.log_level)
    try:
        asyncio.run(serve(config))
    except DeviceError as e:
        log.error("vision.device_unavailable", extra={"error": str(e)})
        sys.exit(1)
