"""检测链路（TK-021、TK-022、TK-118）：go2rtc 拉流 → 运动门控 → RTMO → ByteTrack →
hyd.vision.track.v1 与 hyd.vision.behavior.v1；画面冻结、重放、挪位、遮挡与断流 →
hyd.vision.integrity.v1（D-080、TK-114）。环境分割平时不运行：收到 hyd.vision.scene_request.v1 时对
指定摄像头的当前画面各识别一次，以 hyd.vision.scene_reply.v1 应答（D-133、TK-162）。收到
hyd.vision.calibration_request.v1 时按标定点拟合地面映射，以 hyd.vision.calibration_reply.v1 应答（D-132）。

每路摄像头一个读帧线程，持续解码以跟上源帧率、只保留最新一帧；检测按固定 5 FPS 取用最新帧，
处理慢时丢帧而不积压延迟。只经 go2rtc 取流，不直连摄像头（C-CV-10）。

各路相互隔离（#79）：单路循环异常只重试该路；任一路循环或读帧线程停滞时进程退出，由 Compose 拉起。

摄像头来自 api-server 下发的登记表 hyd.config.cameras.v1（D-101）：新增的启动，删除或参数变化的停止后
按新参数启动，其余不动。没有 4 组标定点时，取到首帧后按安装参数估算地面映射（D-102）。
"""

import asyncio
import logging
import os
import sys
import threading
import time
import uuid
from collections import Counter
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from functools import partial
from pathlib import Path
from typing import Any, Literal

import cv2
import nats
import numpy as np
import supervision as sv
from trackers import ByteTrackTracker

from py_common.bus import Bus
from py_common.config import load_config
from py_common.log import configure_logging
from py_contracts.events.hyd_config_cameras_v1_schema import ConfigCamerasV1
from py_contracts.events.hyd_vision_behavior_v1_schema import VisionBehaviorV1
from py_contracts.events.hyd_vision_calibration_reply_v1_schema import VisionCalibrationReplyV1
from py_contracts.events.hyd_vision_calibration_request_v1_schema import (
    VisionCalibrationRequestV1,
)
from py_contracts.events.hyd_vision_integrity_v1_schema import VisionIntegrityV1
from py_contracts.events.hyd_vision_scene_reply_v1_schema import VisionSceneReplyV1
from py_contracts.events.hyd_vision_scene_request_v1_schema import VisionSceneRequestV1
from py_contracts.events.hyd_vision_scene_v1_schema import VisionSceneV1
from py_contracts.events.hyd_vision_track_v1_schema import VisionTrackV1
from vision_engine.behavior import BehaviorDetector
from vision_engine.detector import VEHICLES, PoseDetector, VehicleDetector
from vision_engine.footing import (
    FOOT_ERROR_RATIO,
    VEHICLE_ERROR_RATIO,
    PersonFooting,
    vehicle_offset,
)
from vision_engine.geometry import GroundMapping
from vision_engine.integrity import (
    FREEZE_S,
    REPLAY_S,
    VIEW_S,
    FrameEmbedder,
    FreezeDetector,
    ReplayDetector,
    ViewDetector,
)
from vision_engine.kinematics import Motion
from vision_engine.motion import MotionGate
from vision_engine.runtime import DeviceError, VisionConfig, create_session, model_files
from vision_engine.scene import ScenePerception, Segmenter

FPS = 5  # 固定检测帧率（FR-101、C-CV-08），与模型卡一致
TRACK_SUBJECT = "hyd.vision.track.v1"
BEHAVIOR_SUBJECT = "hyd.vision.behavior.v1"
SCENE_REQUEST_SUBJECT = "hyd.vision.scene_request.v1"  # 核心 NATS 请求/应答，不持久化
CALIBRATION_REQUEST_SUBJECT = "hyd.vision.calibration_request.v1"  # 同上
INTEGRITY_SUBJECT = "hyd.vision.integrity.v1"
REGISTRY_SUBJECT = "hyd.config.cameras.v1"  # 摄像头登记表，流中只保留最新一条（D-101）
# 持久化的视觉事件（architecture.md §12）。
# 保留期取检测事件的默认值 180 天（architecture.md §10）
STREAM = "HYD_VISION"
STREAM_SUBJECTS = [BEHAVIOR_SUBJECT, INTEGRITY_SUBJECT]
STREAM_MAX_AGE_S = 180 * 86400
SCHEMA_VERSION = "1.0.0"
INTEGRITY_SCHEMA_VERSION = "1.1.0"  # 1.1：来源与可信度（architecture.md §12）
TRACK_SCHEMA_VERSION = "1.1.0"  # 1.1：类别、朝向、速度、画面框与骨骼（architecture.md §12）
TIMEOUT_MS = 5000  # 拉流的建连与读帧超时（CD-04）
RECONNECT_S = 2.0  # 断流重连与单路循环异常后重试的间隔
STOP_WAIT_S = 2 * TIMEOUT_MS / 1000 + 1  # 停止一路时等读帧线程退出的上限
# 检测循环 5 s 取不到新帧即为断流（FR-105 要求 10 s 内）：不依赖读帧线程何时发现连接断开（go2rtc 的源
# 中断后实测约 15 s 才断开对外连接），推流源切换、重启时的瞬断也不算断流
STREAM_LOST_S = 5.0
# 启动时建连（超时 5 s）并等首个关键帧，再宽限 5 s：启动后 10 s 内取不到帧才按断流上报
STARTUP_GRACE_S = 5.0
STREAM_LOST_REPEAT_S = 30  # 断流期间每 30 s 重报 stream_lost，api-server 据此保持离线（D-092）
STALL_S = 10.0  # 任一循环超过此时长未完成周期即视为停滞，与 compose 健康检查的阈值一致
# 新轨迹须连续 2 帧、置信度 ≥ 0.5；RTMO 对远处行人的置信度多在 0.5～0.6（模型卡）
TRACK_ACTIVATION = 0.5
# 丢失的轨迹保留 3 s 供重新关联：trackers 按 30 帧/秒换算，90 在 5 FPS 下为 15 帧；关联 IoU 下限 0.05。
# 实测遮挡多的素材新编号降 8%～33%，人·秒不减（TK-164）
LOST_TRACK_BUFFER = 90
MIN_IOU = 0.05
# 车辆与人员分别跟踪（骑车人与自行车框重叠，混合跟踪会互换编号）；车辆轨迹编号加此偏移，同一路内不重复
VEHICLE_ID_BASE = 1_000_000
RELINK_S = 5.0  # 人员轨迹丢失后在此时长内可被续接（FR-911、D-135）
RELINK_M = 1.0  # 续接的距离上限：取此值与两者 uncertainty_m 之大者

log = logging.getLogger(__name__)


class Relinker:
    """按地面位置把新的人员轨迹续接到刚丢失的轨迹（FR-911、D-135），不用外观特征（G-04）。

    跟踪器编号映射为输出编号。新的跟踪编号首次出现时，在 RELINK_S 内丢失、尚未被续接的输出编号中，
    找末位置与其首个位置相距不超过上限的：恰好一个、且本帧没有别的新轨迹也靠近它时沿用，否则用新编号
    （宁可断号，不把两个人接错）。输出编号由本类分配：被续接的编号归新轨迹所有，原跟踪编号再出现时按新出现处理，
    不会两人同号。
    """

    def __init__(self) -> None:
        self._ids: dict[int, int] = {}  # 跟踪编号 → 输出编号
        self._seen: dict[int, float] = {}  # 跟踪编号 → 最近出现的时刻
        self._last: dict[
            int, tuple[float, float, float, float]
        ] = {}  # 输出编号 → (时刻, x, y, 误差)
        self._next = 1

    def assign(
        self, t: float, tracks: list[tuple[int, tuple[float, float, float] | None]]
    ) -> list[int]:
        """tracks 为本帧的 (跟踪编号, (x, y, uncertainty_m) 或 None)，按序返回输出编号。"""
        self._seen = {i: s for i, s in self._seen.items() if t - s <= RELINK_S}
        self._ids = {i: o for i, o in self._ids.items() if i in self._seen}
        self._last = {o: p for o, p in self._last.items() if t - p[0] <= RELINK_S}
        present = {self._ids[i] for i, _ in tracks if i in self._ids}
        lost = {o: p for o, p in self._last.items() if o not in present}
        new = [located for i, located in tracks if i not in self._ids and located is not None]
        out = []
        for track_id, located in tracks:
            if track_id not in self._ids:
                output = self._relink(located, lost, new)
                if output is None:
                    output, self._next = self._next, self._next + 1
                else:
                    del lost[output]
                    self._ids = {i: o for i, o in self._ids.items() if o != output}
                self._ids[track_id] = output
            self._seen[track_id] = t
            if located is not None:
                self._last[self._ids[track_id]] = (t, *located)
            out.append(self._ids[track_id])
        return out

    @staticmethod
    def _relink(
        located: tuple[float, float, float] | None,
        lost: dict[int, tuple[float, float, float, float]],
        new: list[tuple[float, float, float]],
    ) -> int | None:
        """双向唯一才续接：该新轨迹附近只有一个丢失轨迹，且那个丢失轨迹附近只有这一个新轨迹。"""
        if located is None:
            return None
        near = [o for o, last in lost.items() if _near(located, last[1:])]
        if len(near) != 1:
            return None
        rivals = [n for n in new if _near(n, lost[near[0]][1:])]
        return near[0] if len(rivals) == 1 else None


def _near(a: tuple[float, float, float], b: tuple[float, float, float]) -> bool:
    """两个 (x, y, 误差) 地面位置相距不超过续接上限：1 m 与双方误差中的较大者。"""
    return bool(np.hypot(a[0] - b[0], a[1] - b[1]) <= max(RELINK_M, a[2], b[2]))


class FrameReader(threading.Thread):
    def __init__(self, camera_id: str, url: str, beat: Callable[[], None]) -> None:
        super().__init__(name=f"reader-{camera_id}", daemon=True)
        self._camera_id = camera_id
        self._url = url
        self._beat = beat  # 每次建连与每读到一帧登记一次，卡在读帧调用中即停滞（#79）
        self._lock = threading.Lock()
        self._latest: tuple[int, np.ndarray] | None = None
        self._latest_at = float("-inf")  # 取到最新一帧的时刻（time.monotonic）
        self._stopping = threading.Event()  # 摄像头从登记表删除或参数变化时停止（D-101）
        self._beat_lock = threading.Lock()  # stop 返回后不会再有登记

    def stop(self) -> None:
        """至迟在当前读帧调用超时（TIMEOUT_MS）后退出；返回后不再登记心跳。"""
        with self._beat_lock:
            self._stopping.set()

    def _alive(self) -> None:
        """停止后不再登记：否则读完正在进行的一帧后，已移除的健康登记被写回，10 s 后整个进程被判停滞。"""
        with self._beat_lock:
            if not self._stopping.is_set():
                self._beat()

    def latest(self) -> tuple[int, np.ndarray] | None:
        """(序号, 帧)；序号不变表示没有新帧（如断流期间）。"""
        with self._lock:
            return self._latest

    def age_s(self) -> float:
        """最新一帧距今的秒数；尚未取到帧时为无穷大。"""
        with self._lock:
            return time.monotonic() - self._latest_at

    def run(self) -> None:
        seq, lost = 0, False
        while not self._stopping.is_set():
            self._alive()
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
                # 建连与读帧各有 5 s 超时：建连后再登记一次，断流重连的整个周期不超过 STALL_S
                self._alive()
                while not self._stopping.is_set():
                    ok, frame = capture.read()
                    if not ok:
                        break
                    if lost:
                        log.info("vision.stream_restored", extra={"camera_id": self._camera_id})
                        lost = False
                    seq += 1
                    self._alive()
                    with self._lock:
                        self._latest, self._latest_at = (seq, frame), time.monotonic()
                capture.release()
            except cv2.error:
                # 解码器异常按断流处理并重连，读帧线程不退出（#79）
                log.exception("vision.reader_failed", extra={"camera_id": self._camera_id})
            if self._stopping.is_set():
                break
            if not lost:
                # 不静默跳过（C-CV-09）：stream_lost 事件由检测循环按取不到新帧的时长发布（FR-105）
                log.warning("vision.stream_lost", extra={"camera_id": self._camera_id})
                lost = True
            self._stopping.wait(RECONNECT_S)


class CameraPipeline:
    """单路的门控、检测与跟踪；状态只在本路串行调用的 process 中使用。"""

    def __init__(
        self,
        camera_id: str,
        mapping: GroundMapping | None,
        detector: PoseDetector,
        climb_lines: list[list[float]] | None = None,
        vehicles: VehicleDetector | None = None,
        embedder: FrameEmbedder | None = None,
        pose: dict[str, Any] | None = None,
    ) -> None:
        self._camera_id = camera_id
        self._mapping = mapping
        # 没有标定映射时，取到首帧后按安装参数估算（D-102）；估算不成立（如朝向地平线以上）只算一次
        self._pose = pose if mapping is None else None
        self._detector = detector
        self._vehicles = vehicles  # None 时没有车辆，人员只有 RTMO 的正向检出
        self._behaviors = BehaviorDetector(climb_lines or [])
        self._freeze = FreezeDetector()
        self._embedder = embedder  # None 时不判定重放、挪位与遮挡
        self._replay = ReplayDetector()
        self._view = ViewDetector()
        self._lost_reported: float | None = None  # 本次断流最近一次上报的时刻
        self._gate = MotionGate()
        self._tracker, self._vehicle_tracker = (
            ByteTrackTracker(
                lost_track_buffer=LOST_TRACK_BUFFER,
                frame_rate=FPS,
                track_activation_threshold=TRACK_ACTIVATION,
                minimum_iou_threshold=MIN_IOU,
                high_conf_det_threshold=TRACK_ACTIVATION,
            )
            for _ in range(2)
        )
        self._motion = Motion()
        self._footing = PersonFooting()
        self._relinker = Relinker()
        self._votes: dict[int, Counter[int]] = {}  # 车辆轨迹 → 各帧检出类别的计数
        self._boxes = np.empty((0, 4))

    def track(self, frame: np.ndarray, timestamp: float) -> tuple[sv.Detections, sv.Detections]:
        """门控、检测与跟踪，返回已确认的人员轨迹（含关键点）与车辆轨迹；无运动且无轨迹时为空。"""
        region = self._gate.region(frame, self._boxes)
        if region is None:
            return sv.Detections.empty(), sv.Detections.empty()
        x1, y1, x2, y2 = region
        crop = frame[y1:y2, x1:x2]
        # RF-DETR 一次推理同时给出车辆与人员框；人员框交给 RTMO 合并并配上骨骼（#287）
        found, persons = (
            self._vehicles(crop, offset=(x1, y1))
            if self._vehicles is not None
            else (sv.Detections.empty(), None)
        )
        people = self._confirmed(
            self._tracker, self._detector(crop, offset=(x1, y1), persons=persons), timestamp
        )
        vehicles = self._confirmed(self._vehicle_tracker, found, timestamp)
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
    ) -> list[VisionTrackV1 | VisionBehaviorV1 | VisionIntegrityV1]:
        # 画面可信度判定先于运动门控：定格画面没有运动，门控会跳过推理（C-CV-09）
        integrity: list[VisionIntegrityV1] = []
        if self._freeze.update(frame, timestamp):
            integrity.append(self._integrity("freeze", FREEZE_S, "rule", 1.0, None))
        if self._embedder is not None:
            embedding = self._embedder(frame)
            replay = self._replay.update(embedding, timestamp)
            if replay is not None:
                # 只写相对时刻：界面与报告按站点时区显示，这里写 UTC 钟点会与之对不上（D-106）
                detail = f"画面与 {replay.ago_s:.0f} s 前的片段重复"
                integrity.append(
                    self._integrity("replay", REPLAY_S, "model", replay.confidence, detail)
                )
            view = self._view.update(embedding, frame, timestamp)
            if view is not None:
                detail = f"与参考画面的相似度降至 {view.similarity:.2f}"
                if view.kind == "occlusion":
                    detail = f"画面纹理消失，{detail}"
                integrity.append(
                    self._integrity(view.kind, VIEW_S, "model", view.confidence, detail)
                )
        tracked, vehicles = self.track(frame, timestamp)
        if not len(tracked) and not len(vehicles):
            return integrity
        height, width = frame.shape[:2]
        if self._mapping is None and self._pose is not None:
            self._mapping = GroundMapping.from_pose(self._pose, width, height)
            self._pose = None
        mapping = self._mapping
        people = (
            list(
                zip(
                    tracked.xyxy,
                    tracked.tracker_id,
                    tracked.data["keypoints"],
                    tracked.data["keypoint_scores"],
                    strict=True,
                )
            )
            if len(tracked)  # 空结果不含关键点数据
            else []
        )
        # 先算位置再续接，行为判定用续接后的编号；没有地面映射时不续接、用跟踪编号（FR-911、C-CV-05）
        positions = [
            None
            if mapping is None
            else mapping.locate(*self._footing.foot(int(i), tuple(box), points, scores, timestamp))
            for box, i, points, scores in people
        ]
        ids = (
            [int(i) for _, i, _, _ in people]
            if mapping is None
            else self._relinker.assign(
                timestamp,
                [(int(p[1]), located) for p, located in zip(people, positions, strict=True)],
            )
        )
        now = datetime.now(UTC)
        # 未标定摄像头同样判定行为：只输出设备级告警（C-CV-05）
        events: list[VisionTrackV1 | VisionBehaviorV1 | VisionIntegrityV1] = integrity + [
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
                    np.array(ids),
                    tracked.data["keypoints"],
                    tracked.data["keypoint_scores"],
                    timestamp,
                )
                if people
                else []
            )
        ]
        if mapping is None:
            return events  # 没有地面映射不输出坐标（FR-902）
        scale = np.array([width, height], dtype=np.float32)
        targets = [
            (output_id, "person", box, (points, scores), located)
            for (box, _, points, scores), output_id, located in zip(
                people, ids, positions, strict=True
            )
        ] + [
            (VEHICLE_ID_BASE + i, VEHICLES[self._vote(i, c)], box, None, None)
            for box, i, c in (
                zip(vehicles.xyxy, vehicles.tracker_id, vehicles.class_id, strict=True)
                if len(vehicles)
                else []
            )
        ]
        current = set(vehicles.tracker_id.tolist()) if len(vehicles) else set()
        self._votes = {i: v for i, v in self._votes.items() if i in current}
        for track_id, object_class, (bx1, by1, bx2, by2), skeleton, located in targets:
            if skeleton is not None:  # 人员取站立的脚点（FR-911）
                if located is None:
                    continue
                x, y, uncertainty = located
                heading, speed = self._motion.update(track_id, timestamp, x, y)
            else:
                # 车辆：朝向与速度按框底边中点映射的近端点估计，再沿视线外移到车身中心（FR-911）。
                # 不按外移后的位置估计：外移量随朝向变化，会反过来扰动朝向
                u = (bx1 + bx2) / 2
                located = mapping.locate(u, by2, FOOT_ERROR_RATIO * (by2 - by1))
                outward = mapping.outward(u, by2)
                if located is None or outward is None:
                    continue
                near_x, near_y, uncertainty = located
                heading, speed = self._motion.update(track_id, timestamp, near_x, near_y)
                offset = vehicle_offset(object_class, heading, outward)
                x, y = near_x + float(offset[0]), near_y + float(offset[1])
                uncertainty += VEHICLE_ERROR_RATIO * float(np.hypot(*offset))
            keypoints = (
                None if skeleton is None else np.column_stack([skeleton[0] / scale, skeleton[1]])
            )
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

    def stream_lost(self, last_frame: float, now: float) -> VisionIntegrityV1 | None:
        """last_frame 为最近一次取到新帧的时刻：满 STREAM_LOST_S 没有新帧时上报，持续断流每
        STREAM_LOST_REPEAT_S 重报（D-092）；duration_s 为没有新帧的时长。"""
        if now - last_frame < STREAM_LOST_S:
            self._lost_reported = None
            return None
        if self._lost_reported is not None and now - self._lost_reported < STREAM_LOST_REPEAT_S:
            return None
        self._lost_reported = now
        return self._integrity("stream_lost", now - last_frame, "rule", 1.0, None)

    def _integrity(
        self,
        kind: Literal["freeze", "replay", "shift", "occlusion", "stream_lost"],
        duration_s: float,
        source: Literal["rule", "model"],
        confidence: float,
        detail: str | None,
    ) -> VisionIntegrityV1:
        return VisionIntegrityV1(
            schema_version=INTEGRITY_SCHEMA_VERSION,
            event_id=uuid.uuid4(),
            ts=datetime.now(UTC),
            camera_id=self._camera_id,
            type=kind,
            duration_s=duration_s,
            source=source,
            confidence=confidence,
            detail=detail,
        )


class Health:
    """按路判断健康（#79）：各循环每完成一个周期、读帧线程每次建连与每读到一帧登记一次。
    全部在 STALL_S 内有登记时每秒更新心跳文件；任一路停滞（卡住或线程意外退出）即退出进程，
    由 Compose 的重启策略拉起——卡在推理或读帧调用中的线程无法在进程内恢复。"""

    def __init__(self, heartbeat_file: Path) -> None:
        self._file = heartbeat_file
        self._beats: dict[str, float] = {}

    def beat(self, name: str) -> None:
        self._beats[name] = time.monotonic()

    def forget(self, prefix: str) -> None:
        """停止的摄像头不再参与停滞判断。"""
        self._beats = {k: v for k, v in self._beats.items() if not k.startswith(prefix)}

    def stalled(self) -> list[str]:
        now = time.monotonic()
        return [name for name, t in self._beats.items() if now - t > STALL_S]

    async def run(self) -> None:
        while True:
            stalled = self.stalled()
            if stalled:
                log.error("vision.stalled", extra={"loops": stalled})
                os._exit(1)  # 不等待卡住的线程：asyncio.run 退出时会等执行器线程结束
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
            # 出错后仍在重试不算停滞：否则持续报错的一路会让整个进程退出，连累其他路
            health.beat(name)
            await asyncio.sleep(RECONNECT_S)


async def run_camera(
    pipeline: CameraPipeline, reader: FrameReader, bus: Bus, beat: Callable[[], None]
) -> None:
    loop = asyncio.get_running_loop()
    next_tick, last_seq = loop.time(), 0
    last_frame = time.monotonic() + STARTUP_GRACE_S  # 启动后一直取不到帧同样按断流上报（C-CV-09）
    while True:
        next_tick = max(next_tick + 1 / FPS, loop.time())  # 处理超时后不补跑积压的周期
        await asyncio.sleep(next_tick - loop.time())
        latest, now = reader.latest(), time.monotonic()
        events: list[VisionTrackV1 | VisionBehaviorV1 | VisionIntegrityV1] = []
        if latest is not None and latest[0] != last_seq:
            last_seq, frame = latest
            last_frame = now
            events = await asyncio.to_thread(pipeline.process, frame, now)
        lost = pipeline.stream_lost(last_frame, now)
        if lost is not None:
            events.append(lost)
        for event in events:
            if isinstance(event, VisionTrackV1):
                await bus.publish(TRACK_SUBJECT, event)
                continue
            subject = (
                INTEGRITY_SUBJECT if isinstance(event, VisionIntegrityV1) else BEHAVIOR_SUBJECT
            )
            try:
                await bus.js_publish(subject, event)
            except (nats.errors.Error, TimeoutError):
                # 记录后继续检测：持续满足的行为与断流 30 s 后重发（C-CV-09 不静默）；冻结等只报一次
                log.exception(
                    "vision.event_publish_failed",
                    extra={"subject": subject, "event_id": str(event.event_id)},
                )
        beat()


def mapping_of(camera: dict[str, Any], frame: np.ndarray) -> GroundMapping | None:
    """按标定点拟合；不足 4 组时按安装参数与画面尺寸估算（D-102）。"""
    mapping = GroundMapping.fit(camera["calibration"])
    if mapping is None:
        height, width = frame.shape[:2]
        mapping = GroundMapping.from_pose(camera["pose"], width, height)
    return mapping


@dataclass
class _Running:
    camera: dict[str, Any]
    reader: FrameReader
    tasks: list[asyncio.Task[None]]


class Cameras:
    """按登记表运行各路摄像头（D-101）：新增的启动，删除或参数变化的停止后按新参数启动，其余不动。"""

    def __init__(
        self,
        config: VisionConfig,
        detector: PoseDetector,
        vehicles: VehicleDetector | None,
        segmenter: Segmenter | None,
        embedder: FrameEmbedder | None,
        bus: Bus,
        health: Health,
    ) -> None:
        self._config, self._bus, self._health = config, bus, health
        self._detector, self._vehicles = detector, vehicles
        self._segmenter, self._embedder = segmenter, embedder
        self._running: dict[str, _Running] = {}

    async def apply(self, event: ConfigCamerasV1) -> None:
        wanted = {c["id"]: c for c in event.model_dump(mode="json")["cameras"]}
        for camera_id in list(self._running):
            if wanted.get(camera_id) != self._running[camera_id].camera:
                await self._stop(camera_id)
        for camera_id, camera in wanted.items():
            if camera_id not in self._running:
                self._start(camera)
        log.info("vision.cameras", extra={"cameras": sorted(wanted)})

    def _start(self, camera: dict[str, Any]) -> None:
        camera_id = camera["id"]
        reader_name = f"{camera_id}/reader"
        self._health.beat(reader_name)
        reader = FrameReader(
            camera_id,
            f"{self._config.go2rtc_rtsp}/{camera_id}",  # 流名即摄像头编号（D-101）
            partial(self._health.beat, reader_name),
        )
        reader.start()
        mapping = GroundMapping.fit(camera["calibration"])
        detection = CameraPipeline(
            camera_id,
            mapping,
            self._detector,
            camera["climb_lines"],
            self._vehicles,
            self._embedder,
            camera["pose"],
        )
        runs = [
            supervise(
                f"{camera_id}/detect",
                partial(run_camera, detection, reader, self._bus),
                self._health,
            )
        ]
        self._running[camera_id] = _Running(camera, reader, [asyncio.create_task(r) for r in runs])

    async def recognize(self, request: VisionSceneRequestV1) -> VisionSceneReplyV1:
        """对请求中各摄像头的当前画面识别一次环境，供场景初稿（D-133、FR-909）；识别不了的给出原因。"""
        frames: list[VisionSceneV1] = []
        unavailable: list[dict[str, str]] = []
        for camera_id in request.camera_ids:
            scene = await self._recognize(camera_id)
            if isinstance(scene, str):
                unavailable.append({"camera_id": camera_id, "reason": scene})
            else:
                frames.append(scene)
        return VisionSceneReplyV1.model_validate(
            {
                "schema_version": SCHEMA_VERSION,
                "event_id": uuid.uuid4(),
                "ts": datetime.now(UTC),
                "frames": frames,
                "unavailable": unavailable,
            }
        )

    async def _recognize(self, camera_id: str) -> VisionSceneV1 | str:
        """识别帧，或 SceneUnavailable 的 reason。"""
        if self._segmenter is None:
            return "model_missing"  # 未配置 HYD_SCENE_MODEL_FILE
        running = self._running.get(camera_id)
        latest = running.reader.latest() if running else None
        # 与检测循环同一断流标准；登记表尚未下发到本服务的摄像头同样没有画面
        if running is None or latest is None or running.reader.age_s() > STREAM_LOST_S:
            return "no_frame"
        frame = latest[1]
        mapping = mapping_of(running.camera, frame)
        if mapping is None:
            return "unmapped"
        perception = ScenePerception(camera_id, mapping, running.camera["pose"], self._segmenter)
        return await asyncio.to_thread(perception.process, frame) or "empty"

    async def _stop(self, camera_id: str) -> None:
        running = self._running.pop(camera_id)
        for task in running.tasks:
            task.cancel()
        await asyncio.gather(*running.tasks, return_exceptions=True)
        running.reader.stop()
        # 先移除健康登记再等读帧线程退出：等待至多 STOP_WAIT_S，超过停滞阈值；stop 返回后线程不再登记
        self._health.forget(f"{camera_id}/")
        await asyncio.to_thread(running.reader.join, STOP_WAIT_S)
        if running.reader.is_alive():
            log.warning("vision.reader_stop_slow", extra={"camera_id": camera_id})


async def calibrate(request: VisionCalibrationRequestV1) -> VisionCalibrationReplyV1:
    """按标定点拟合地面映射，供标定对话框显示误差与保存前校验（FR-910）。纯计算，与该路是否运行无关。"""
    # 退化时最坏要遍历 C(20, 4) 种组合：放到线程里算，不阻塞同进程的检测与心跳
    result = await asyncio.to_thread(GroundMapping.calibrate, [p.root for p in request.points])
    if isinstance(result, str):
        reply: dict[str, Any] = {"reason": result, "reproj_error_m": None, "residuals_m": None}
    else:
        mapping, residuals = result
        reply = {"reason": None, "reproj_error_m": mapping.reproj_error_m, "residuals_m": residuals}
    log.info(
        "vision.calibration_checked",
        extra={"camera_id": request.camera_id, "points": len(request.points)} | reply,
    )
    return VisionCalibrationReplyV1.model_validate(
        {"schema_version": SCHEMA_VERSION, "event_id": uuid.uuid4(), "ts": datetime.now(UTC)}
        | reply
    )


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
    embedder = (
        FrameEmbedder(create_session(config, config.integrity_model_file, models))
        if config.integrity_model_file
        else None
    )
    if vehicles is None:
        log.warning("vision.vehicles_disabled")  # 未配置 HYD_VEHICLE_MODEL_FILE
    if segmenter is None:
        log.warning("vision.scene_disabled")  # 未配置 HYD_SCENE_MODEL_FILE
    if embedder is None:
        log.warning("vision.replay_disabled")  # 未配置 HYD_INTEGRITY_MODEL_FILE
    bus = await Bus.connect(config.nats_url, name="vision-engine", timeout_s=config.nats_timeout_s)
    await bus.ensure_stream(STREAM, STREAM_SUBJECTS, STREAM_MAX_AGE_S)
    health = Health(config.heartbeat_file)
    cameras = Cameras(config, detector, vehicles, segmenter, embedder, bus, health)
    # 登记表的流由 api-server 创建；它尚未启动时重试
    while True:
        try:
            await bus.js_subscribe(
                REGISTRY_SUBJECT, ConfigCamerasV1, cameras.apply, datetime.fromtimestamp(0, UTC)
            )
            break
        except (nats.errors.Error, TimeoutError):
            log.warning("vision.registry_unavailable")
            health.beat("registry")
            await asyncio.sleep(RECONNECT_S)
    health.forget("registry")
    await bus.serve(SCENE_REQUEST_SUBJECT, VisionSceneRequestV1, cameras.recognize)
    await bus.serve(CALIBRATION_REQUEST_SUBJECT, VisionCalibrationRequestV1, calibrate)
    log.info("vision.started", extra={"device": config.device})
    await health.run()


def main() -> None:
    """hyd-vision：常驻检测。声明 cuda 而未生效时以 1 退出（C-CV-11）。"""
    config = load_config(VisionConfig)
    configure_logging("vision-engine", config.log_level)
    try:
        asyncio.run(serve(config))
    except DeviceError as e:
        log.error("vision.device_unavailable", extra={"error": str(e)})
        sys.exit(1)
