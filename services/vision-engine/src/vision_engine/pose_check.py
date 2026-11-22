"""安装参数自检：只有安装参数估算的地面映射时（D-102），由画面中站立行人检查安装高度与俯角是否离谱，并给出建议值。

安装参数是人工填写的近似值，填错时人员位置成倍偏离、速度虚高（如手机实际约 1 m 高、近乎平视，却按默认 3 m、−30°
估算，位置跳到 20 m 外、速度 30 m/s）。站立行人是现成的标尺：脚踝视线落地处正上方，肩部视线的高度应约为
SHOULDER_ABOVE_ANKLE_M。

- 高度：画面整体等比放大时这一比值不变，推算肩高与安装高度大致成正比，建议高度 = 当前高度 × 标准肩高 / 推算肩高
- 俯角：俯角错了，近处与远处行人推算出的肩高不一致；在俯角网格上取各样本推算肩高（对数）方差最小者。
  行人在画面中的远近分布不足（脚点纵向跨度 < MIN_SPREAD）时无法区分，只建议高度
- 速度：移动轨迹的速度 95 分位超过 MAX_WALK_MPS 时同样可疑（多为高度或俯角错，位置被成倍放大）

朝向与水平位置不影响高度，求解中取朝向 0、摄像头在原点。约定与 GroundMapping.from_pose 一致。
"""

import math
from collections import deque
from dataclasses import dataclass
from typing import Any, Literal

import numpy as np

SHOULDER_ABOVE_ANKLE_M = 1.34  # 1.70 m 人员肩中离地约 1.42 m，减去脚踝离地 0.08 m
ANKLE_M = 0.08
STANDARD_HEIGHT_M = 1.70  # 由肩高比例换算推算身高，只用于提示
KEYPOINT_MIN = 0.5  # 样本所用关键点置信度下限：比判定行为更严，宁缺毋滥
MAX_TORSO_TILT_DEG = 20.0  # 躯干（髋→肩）偏离竖直不超过此值
MIN_KNEE_DEG = 160.0  # 髋—膝—踝夹角不小于此值：腿伸直，排除坐、蹲
MIN_BOX_RATIO = 0.05  # 人高不足画面高的此比例不取：关键点误差占比太大
SAMPLE_GAP_S = 1.0  # 同一轨迹两次取样的最短间隔：免得一个站着不动的人占满样本
MAX_SAMPLES = 300
MIN_SAMPLES = 15
MIN_SPREAD = 0.1  # 脚点纵向跨度（占画面高）不足时不建议俯角
PITCH_GRID = np.arange(-85.0, 10.01, 0.5)
MIN_VALID = 0.8  # 某一俯角下脚踝视线须朝下（能落地）的样本比例
HEIGHT_TOLERANCE = 1.3  # 建议高度与当前相差超过此倍数即可疑
PITCH_TOLERANCE_DEG = 8.0
MAX_WALK_MPS = 4.0
MOVING_MPS = 0.3
SPEED_WINDOW = 200

type Status = Literal["ok", "suspect", "insufficient"]


@dataclass(frozen=True)
class PoseCheck:
    status: Status
    samples: int
    person_height_m: float | None  # 按当前参数推算的站立身高中位
    speed_p95_mps: float | None
    suggested_height_m: float | None
    suggested_pitch_deg: float | None
    reasons: list[str]


def _rays(
    pixels: np.ndarray, pitch_deg: float, hfov_deg: float, size: tuple[int, int]
) -> np.ndarray:
    """像素 (N, 2) → 视线方向 (N, 3)，朝向 0、z 向上；与 from_pose 同一针孔模型。"""
    width, height = size
    pitch = math.radians(pitch_deg)
    f_px = (width / 2) / math.tan(math.radians(hfov_deg) / 2)
    forward = np.array([math.cos(pitch), 0.0, math.sin(pitch)])
    right = np.array([0.0, 1.0, 0.0])
    down = np.cross(right, forward)
    return (
        forward
        + np.outer((pixels[:, 0] - width / 2) / f_px, right)
        + np.outer((pixels[:, 1] - height / 2) / f_px, down)
    )


def shoulder_heights(
    ankles: np.ndarray, shoulders: np.ndarray, height_m: float, pitch_deg: float, hfov_deg: float,
    size: tuple[int, int],
) -> np.ndarray:  # fmt: skip
    """按给定参数推算各样本肩中高出脚踝的距离（米）；脚踝视线不落地的样本为 NaN。"""
    a = _rays(ankles, pitch_deg, hfov_deg, size)
    s = _rays(shoulders, pitch_deg, hfov_deg, size)
    with np.errstate(divide="ignore", invalid="ignore"):
        t = np.where(a[:, 2] < -1e-6, (ANKLE_M - height_m) / a[:, 2], np.nan)
        reach = t * np.hypot(a[:, 0], a[:, 1])  # 脚踝落地处离摄像头的水平距离
        rise = reach * s[:, 2] / np.hypot(s[:, 0], s[:, 1])
    return height_m + rise - ANKLE_M


def _point(points: np.ndarray, scores: np.ndarray, idx: tuple[int, ...]) -> np.ndarray | None:
    if np.any(scores[list(idx)] < KEYPOINT_MIN):
        return None
    return points[list(idx)].mean(axis=0)


def _angle(a: np.ndarray, b: np.ndarray, c: np.ndarray) -> float:
    """∠abc（度）。"""
    u, v = a - b, c - b
    n = float(np.linalg.norm(u) * np.linalg.norm(v))
    return 180.0 if n == 0 else math.degrees(math.acos(np.clip(float(u @ v) / n, -1, 1)))


def standing(
    points: np.ndarray, scores: np.ndarray, box_height: float, frame_height: int
) -> tuple[np.ndarray, np.ndarray] | None:
    """直立、腿伸直的人员：返回（脚踝中点, 肩中）像素；否则 None。COCO 17 点，像素坐标、y 向下。"""
    if box_height < MIN_BOX_RATIO * frame_height:
        return None
    parts = [_point(points, scores, idx) for idx in ((5, 6), (11, 12), (15, 16))]
    shoulder, hip, ankle = parts
    if shoulder is None or hip is None or ankle is None:
        return None
    dx, dy = shoulder - hip
    if dy >= 0 or math.degrees(math.atan2(abs(dx), -dy)) > MAX_TORSO_TILT_DEG:
        return None
    for h, k, a in ((11, 13, 15), (12, 14, 16)):
        if min(scores[h], scores[k], scores[a]) < KEYPOINT_MIN:
            return None
        if _angle(points[h], points[k], points[a]) < MIN_KNEE_DEG:
            return None
    if not hip[1] < ankle[1]:
        return None
    return ankle, shoulder


def _round(value: float | None, digits: int) -> float | None:
    return None if value is None else round(value, digits)


def _advice(
    height: float, pitch: float, suggested: float | None, best_pitch: float | None
) -> tuple[bool, list[str]]:
    """（建议的高度或俯角与当前相差过大，提示）；best_pitch 为 None 表示远近分布不足、不判断俯角。"""
    off, reasons = False, []
    if suggested is not None and abs(math.log(suggested / height)) > math.log(HEIGHT_TOLERANCE):
        off = True
        reasons.append(f"安装高度可能应为约 {suggested:.1f} m（当前 {height:g} m）")
    if best_pitch is None:
        reasons.append("行人在画面中远近分布不足，暂不能判断俯角")
    elif abs(best_pitch - pitch) > PITCH_TOLERANCE_DEG:
        off = True
        reasons.append(f"俯角可能应为约 {best_pitch:.0f}°（当前 {pitch:g}°）")
    return off, reasons


class PoseChecker:
    """单路摄像头的样本累积与自检；只在该路串行调用中使用。"""

    def __init__(self, pose: dict[str, Any], size: tuple[int, int]) -> None:
        self._pose = pose
        self._size = size
        self._samples: deque[tuple[np.ndarray, np.ndarray]] = deque(maxlen=MAX_SAMPLES)
        self._sampled: dict[int, float] = {}
        self._speeds: deque[float] = deque(maxlen=SPEED_WINDOW)

    def add(
        self, track_id: int, points: np.ndarray, scores: np.ndarray, box_height: float, now: float
    ) -> None:
        if now - self._sampled.get(track_id, -math.inf) < SAMPLE_GAP_S:
            return
        sample = standing(points, scores, box_height, self._size[1])
        if sample is None:
            return
        self._sampled[track_id] = now
        self._sampled = {k: t for k, t in self._sampled.items() if now - t < 60}
        self._samples.append(sample)

    def add_speed(self, speed: float | None) -> None:
        if speed is not None and speed >= MOVING_MPS:
            self._speeds.append(speed)

    def check(self) -> PoseCheck:
        height, pitch, hfov = (float(self._pose[k]) for k in ("height_m", "pitch_deg", "hfov_deg"))
        speed_p95 = (
            float(np.percentile(list(self._speeds), 95)) if len(self._speeds) >= 10 else None
        )
        fast = speed_p95 is not None and speed_p95 > MAX_WALK_MPS
        reasons = [f"人员移动速度 95 分位 {speed_p95:.1f} m/s，远超步行速度"] if fast else []
        n = len(self._samples)
        if n < MIN_SAMPLES:
            if not fast:
                reasons.append(
                    f"站立行人样本 {n} 个，至少需要 {MIN_SAMPLES} 个（需要全身入镜、腿伸直）"
                )
            status: Status = "suspect" if fast else "insufficient"
            return PoseCheck(status, n, None, speed_p95, None, None, reasons)

        ankles = np.array([a for a, _ in self._samples], dtype=np.float64)
        shoulders = np.array([s for _, s in self._samples], dtype=np.float64)
        person = self._person_height(ankles, shoulders, height, pitch, hfov)
        spread = float(np.ptp(ankles[:, 1])) / self._size[1]
        best_pitch = (
            self._best_pitch(ankles, shoulders, height, pitch, hfov)
            if spread >= MIN_SPREAD
            else None
        )
        suggested = self._height_for(
            ankles, shoulders, height, pitch if best_pitch is None else best_pitch, hfov
        )

        if person is not None:
            reasons.insert(0, f"按当前参数推算行人身高约 {person:.1f} m")
        off, advice = _advice(height, pitch, suggested, best_pitch)
        return PoseCheck(
            "suspect" if fast or off else "ok",
            n,
            _round(person, 2),
            _round(speed_p95, 2),
            _round(suggested, 2),
            _round(best_pitch, 1),
            reasons + advice,
        )

    def _person_height(
        self, ankles: np.ndarray, shoulders: np.ndarray, height: float, pitch: float, hfov: float
    ) -> float | None:
        """按给定参数推算的站立身高中位；没有一个样本的脚踝视线落地时为 None。"""
        h = shoulder_heights(ankles, shoulders, height, pitch, hfov, self._size)
        valid = h[np.isfinite(h) & (h > 0)]
        if not len(valid):
            return None
        return float(np.median(valid)) / SHOULDER_ABOVE_ANKLE_M * STANDARD_HEIGHT_M

    def _best_pitch(
        self, ankles: np.ndarray, shoulders: np.ndarray, height: float, pitch: float, hfov: float
    ) -> float:
        """俯角网格上各样本推算肩高（对数）方差最小者；没有一个俯角能让足够多的样本落地时为当前俯角。"""
        best, best_cost = pitch, math.inf
        for candidate in PITCH_GRID:
            h = shoulder_heights(ankles, shoulders, height, float(candidate), hfov, self._size)
            ok = np.isfinite(h) & (h > 0)
            if ok.mean() < MIN_VALID:
                continue
            cost = float(np.var(np.log(h[ok])))
            if cost < best_cost:
                best, best_cost = float(candidate), cost
        return best

    def _height_for(
        self, ankles: np.ndarray, shoulders: np.ndarray, height: float, pitch: float, hfov: float
    ) -> float | None:
        """使推算肩高中位等于标准肩高的安装高度：比值与高度近似成正比（脚踝离地是常数），迭代几次收敛。"""
        guess = height
        for _ in range(5):
            h = shoulder_heights(ankles, shoulders, guess, pitch, hfov, self._size)
            ok = h[np.isfinite(h) & (h > 0)]
            if len(ok) < MIN_SAMPLES:
                return None
            guess *= SHOULDER_ABOVE_ANKLE_M / float(np.median(ok))
            guess = min(max(guess, 0.2), 50.0)
        return guess
