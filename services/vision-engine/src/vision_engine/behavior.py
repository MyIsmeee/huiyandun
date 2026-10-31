"""行为判定（FR-103、FR-104、C-CV-04）：按轨迹的骨骼几何与持续时间判定跌倒、攀爬。

输入为每帧已确认轨迹的 COCO 17 关键点（像素坐标，y 向下）与置信度；时刻 now 为秒，只用于计时。
每帧对每条轨迹的判定为"满足 / 不满足 / 无法判断（关键点不可见）"：不满足即中断计时；
无法判断或轨迹漏检不超过 GAP_S 时不中断，以容忍偶发漏检。
"""

import math
from dataclasses import dataclass, field
from typing import Literal

import numpy as np

MIN_DURATION_S = 2.0  # 持续时长门限（C-CV-04 默认 min_duration）
MIN_CONFIDENCE = 0.5  # 判定所用关键点置信度的均值门限（C-CV-04）
REPEAT_S = 30.0  # 持续满足时的重发间隔：使设备保持物理告警（解除时长 60 s，HYD-UIX-004 §5.2）
GAP_S = 1.0  # 漏检或无法判断不超过此时长时不中断计时
FORGET_S = 10.0  # 轨迹消失超过此时长即丢弃其判定状态
KEYPOINT_MIN = 0.3  # 关键点置信度低于此值视为不可见
FALL_TORSO_DEG = 60.0  # 躯干（髋→肩）与竖直向上方向的夹角下限
FALL_HIP_RATIO = 0.5  # 髋部高出腿部最低点的距离 / 躯干长度 的上限：髋部接近地面
# 已发出跌倒事件后改用更宽的门限（回差）：倒地者在门限附近的逐帧抖动不中断，一次跌倒不拆成多条事件
# （#134）；站起（躯干接近竖直或髋部抬高）仍立即中断。发出前仍按进入门限，不因回差延长可疑姿态而误报
FALL_EXIT_TORSO_DEG = 45.0
FALL_EXIT_HIP_RATIO = 0.75

SHOULDERS, HIPS, LEGS, ANKLES = (5, 6), (11, 12), (13, 14, 15, 16), (15, 16)

type Kind = Literal["fall", "climb"]


@dataclass(frozen=True)
class Behavior:
    track_id: int
    behavior: Kind
    confidence_avg: float
    start: float
    end: float


def _visible(scores: np.ndarray, idx: tuple[int, ...]) -> list[int]:
    return [i for i in idx if scores[i] >= KEYPOINT_MIN]


def fall_frame(
    points: np.ndarray, scores: np.ndarray, falling: bool = False
) -> tuple[bool, float] | None:
    """躯干倾角与髋部高度（FR-103）。返回（是否满足, 所用关键点置信度均值）；不可见为 None。
    falling 为该轨迹已发出跌倒事件，按退出门限判定。"""
    shoulders, hips, legs = (_visible(scores, idx) for idx in (SHOULDERS, HIPS, LEGS))
    if not shoulders or not hips or not legs:
        return None
    hip = points[hips].mean(axis=0)
    dx, dy = points[shoulders].mean(axis=0) - hip
    torso = math.hypot(dx, dy)
    if torso == 0:
        return None
    tilt = math.degrees(math.atan2(abs(dx), -dy))  # 0° 为直立，180° 为倒立
    hip_height = (points[legs, 1].max() - hip[1]) / torso
    score = float(scores[shoulders + hips + legs].mean())
    tilt_min, hip_max = (
        (FALL_EXIT_TORSO_DEG, FALL_EXIT_HIP_RATIO) if falling else (FALL_TORSO_DEG, FALL_HIP_RATIO)
    )
    return tilt > tilt_min and hip_height < hip_max, score


@dataclass
class ClimbLine:
    """警戒线 [u1, v1, u2, v2]（FR-104）。脚踝在线段范围内时，按位于线的哪一侧区分线下与线上。"""

    u1: float
    v1: float
    u2: float
    v2: float

    def __post_init__(self) -> None:
        # 与 api-server 导入校验一致；vision-engine 独立读取 site.yaml，不依赖 api-server 先拦截
        if self.u1 == self.u2:
            raise ValueError(f"警戒线不能是竖直线段：{[self.u1, self.v1, self.u2, self.v2]}")

    def side(self, u: float, v: float) -> Literal["below", "above"] | None:
        """线段范围外（垂足不在线段上）为 None。"""
        du, dv = self.u2 - self.u1, self.v2 - self.v1
        t = ((u - self.u1) * du + (v - self.v1) * dv) / (du * du + dv * dv)
        if not 0 <= t <= 1:
            return None
        cross = du * (v - self.v1) - dv * (u - self.u1)
        # 竖直向上的方向 (0, -1) 与线的叉积为 -du：与之同号的一侧为线上
        return "above" if cross * -du > 0 else "below"


@dataclass
class _Timer:
    """一条轨迹的一种行为：满足的持续时间、置信度与上次发出时刻。"""

    start: float | None = None
    last: float = -math.inf
    scores: list[float] = field(default_factory=list)
    emitted: float | None = None

    def update(self, ok: bool | None, score: float, now: float) -> tuple[float, float] | None:
        """返回需发出事件的（开始时刻, 置信度均值）。"""
        if ok is None:
            return None
        if not ok:
            self.start, self.emitted = None, None
            return None
        if self.start is None or now - self.last > GAP_S:
            self.start, self.scores, self.emitted = now, [], None
        self.last = now
        self.scores.append(score)
        mean = sum(self.scores) / len(self.scores)
        due = self.emitted is None or now - self.emitted >= REPEAT_S
        if now - self.start >= MIN_DURATION_S and mean >= MIN_CONFIDENCE and due:
            self.emitted = now
            return self.start, mean
        return None


@dataclass
class _Track:
    seen: float
    fall: _Timer = field(default_factory=_Timer)
    climbs: dict[int, _Timer] = field(default_factory=dict)
    below: set[int] = field(default_factory=set)  # 脚踝出现过在其下方的警戒线


class BehaviorDetector:
    """单路摄像头的判定状态；只在该路串行调用的 update 中使用。"""

    def __init__(self, climb_lines: list[list[float]]) -> None:
        self._lines = [ClimbLine(*line) for line in climb_lines]
        self._tracks: dict[int, _Track] = {}

    def update(
        self, track_ids: np.ndarray, keypoints: np.ndarray, scores: np.ndarray, now: float
    ) -> list[Behavior]:
        """track_ids (N,)、keypoints (N, 17, 2)、scores (N, 17) 为本帧已确认的轨迹。"""
        found = []
        for track_id, points, kp_scores in zip(track_ids, keypoints, scores, strict=True):
            track = self._tracks.setdefault(int(track_id), _Track(seen=now))
            track.seen = now
            fall = fall_frame(points, kp_scores, falling=track.fall.emitted is not None)
            ok, score = fall if fall is not None else (None, 0.0)
            if (hit := track.fall.update(ok, score, now)) is not None:
                found.append(Behavior(int(track_id), "fall", hit[1], hit[0], now))
            for hit in self._climb(track, points, kp_scores, now):
                found.append(Behavior(int(track_id), "climb", hit[1], hit[0], now))
        self._tracks = {k: t for k, t in self._tracks.items() if now - t.seen <= FORGET_S}
        return found

    def _climb(
        self, track: _Track, points: np.ndarray, scores: np.ndarray, now: float
    ) -> list[tuple[float, float]]:
        """脚踝在警戒线下方出现过、随后越到线上方（FR-104）。脚踝不可见时不中断计时。"""
        ankles = _visible(scores, ANKLES)
        if not ankles:
            return []
        u, v = points[ankles].mean(axis=0)
        score = float(scores[ankles].mean())
        hits = []
        for i, line in enumerate(self._lines):
            side = line.side(u, v)
            if side == "below":
                track.below.add(i)
            ok = side == "above" and i in track.below
            if (hit := track.climbs.setdefault(i, _Timer()).update(ok, score, now)) is not None:
                hits.append(hit)
        return hits
