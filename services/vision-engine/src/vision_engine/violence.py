"""画面级打架识别（VideoMAE，RWF-2000 监控打斗数据集微调）：直接看画面，不依赖骨骼完整。

骨骼路线在群殴时失效：人互相遮挡、骨骼残缺，每秒 5 帧也抓不住出拳（本地群殴素材上规则零命中，动作模型最高 0.47，
与人流的 0.42 分不开）。本模块对整幅画面的最近 CLIP_LEN 帧做二分类（打架 / 非打架）。

模型对剧烈的单人运动（跳跃、奔跑、攀爬）也会给高分，所以只在画面里有两人贴近时推理：两人检测框中心距不超过
CLOSE_RATIO 倍平均身高、身高之比不超过 DEPTH_RATIO（远近相当，排除画面上重叠、实际一前一后）。近 HIT_WINDOW_S
内至少 HITS 次（约 4 次推理中 3 次）打架概率不低于 FIGHT_PROB，即确认打架，对贴得最近的两人各发一条，持续期间每 REPEAT_S 重发。

门限在本地素材与线上录像上核对（models/cards/videomae-rwf2000.md）：群殴开打后持续 0.92～1.00；人流零星可达 0.87；
办公室实录最高 0.01；单人跳跑、攀爬最高 0.96 但没有两人贴近，不推理。

预处理与上游一致：短边缩放到 224、中心裁剪 224×224、RGB、ImageNet 均值方差。上游按约 2 秒取 16 帧；本系统每秒
5 帧，取最近 16 帧（约 3 秒），本地素材上分数与 2 秒取法相当。
"""

import math
from collections import deque
from dataclasses import dataclass, field

import cv2
import numpy as np
import onnxruntime as ort

CLIP_LEN = 16
SIZE = 224
MEAN = np.array([0.485, 0.456, 0.406], np.float32)
STD = np.array([0.229, 0.224, 0.225], np.float32)
FIGHT = 0  # 输出的第一类为打架（RWF-2000 的 Fight），第二类为非打架
MIN_SPAN_S = 2.0  # 片段至少覆盖的时长：刚开始或断帧后不足时不推理
MAX_GAP_S = 1.0  # 相邻两帧间隔超过此值即清空缓冲：断流、长时间无运动后的画面不连续
INTERVAL_S = 1.0  # 每路摄像头推理的间隔
CLOSE_RATIO = 1.0  # 两人检测框中心距 / 两人身高均值 的上限：贴身
DEPTH_RATIO = 1.6  # 两人身高之比的上限：远近相当
# 打架的特征是持续很高：群殴在线上录像中连续 18 s 为 0.92～1.00；人流只是零星偏高（线上录像最高一串
# 0.87、0.84、0.81）。原为 3.5 s 内 2 次 ≥ 0.8，线上人流误报过一次（2026-11-18），改为 4.5 s 内 3 次 ≥ 0.9
FIGHT_PROB = 0.9
HITS = 3
HIT_WINDOW_S = 4.5  # 约 4 次推理
REPEAT_S = 30.0  # 与 behavior.REPEAT_S 一致：持续期间保持物理告警

type Box = tuple[float, float, float, float]


class ViolenceModel:
    """ONNX 会话：输入 (N, 16, 3, 224, 224)，输出 probs (N, 2)。各路摄像头共用。"""

    def __init__(self, session: ort.InferenceSession) -> None:
        self._session = session
        self._input = session.get_inputs()[0].name

    def __call__(self, clip: np.ndarray) -> float:
        probs = self._session.run(["probs"], {self._input: clip[None].astype(np.float32)})[0]
        return float(np.asarray(probs)[0, FIGHT])


def prepare(frame: np.ndarray) -> np.ndarray:
    """BGR 画面 → 224×224 RGB uint8（短边缩放、中心裁剪）。缓冲里只存它，推理时再归一化。"""
    height, width = frame.shape[:2]
    scale = SIZE / min(height, width)
    resized = cv2.resize(
        frame, (round(width * scale), round(height * scale)), interpolation=cv2.INTER_AREA
    )
    h, w = resized.shape[:2]
    y, x = (h - SIZE) // 2, (w - SIZE) // 2
    return cv2.cvtColor(resized[y : y + SIZE, x : x + SIZE], cv2.COLOR_BGR2RGB)


def normalize(frames: list[np.ndarray]) -> np.ndarray:
    """(16, 224, 224, 3) uint8 → (16, 3, 224, 224) float32。"""
    stack = np.stack(frames).astype(np.float32) / 255.0
    return ((stack - MEAN) / STD).transpose(0, 3, 1, 2)


def closest_pair(people: list[tuple[int, Box]]) -> tuple[int, int] | None:
    """贴身、远近相当的两人中，中心距与身高之比最小的一对；没有时为 None。"""
    best: tuple[float, tuple[int, int]] | None = None
    for i, (a_id, a) in enumerate(people):
        for b_id, b in people[i + 1 :]:
            ha, hb = a[3] - a[1], b[3] - b[1]
            if ha <= 0 or hb <= 0 or max(ha, hb) > DEPTH_RATIO * min(ha, hb):
                continue
            ca = ((a[0] + a[2]) / 2, (a[1] + a[3]) / 2)
            cb = ((b[0] + b[2]) / 2, (b[1] + b[3]) / 2)
            ratio = math.hypot(ca[0] - cb[0], ca[1] - cb[1]) / ((ha + hb) / 2)
            if ratio <= CLOSE_RATIO and (best is None or ratio < best[0]):
                best = (ratio, (a_id, b_id))
    return best[1] if best else None


@dataclass
class ViolenceDetector:
    """单路摄像头：缓存最近 CLIP_LEN 帧，两人贴近时每 INTERVAL_S 推理一次。"""

    model: ViolenceModel
    frames: deque[tuple[float, np.ndarray]] = field(default_factory=lambda: deque(maxlen=CLIP_LEN))
    scores: list[tuple[float, float]] = field(default_factory=list)  # (时刻, 打架概率)
    last: float = -math.inf
    emitted: float | None = None

    def update(
        self, frame: np.ndarray, now: float, people: list[tuple[int, Box]]
    ) -> tuple[int, int, float, float] | None:
        """people 为本帧人员（轨迹号, 检测框 x1, y1, x2, y2）。确认打架时返回（甲, 乙, 开始时刻, 概率均值）。"""
        if self.frames and now - self.frames[-1][0] > MAX_GAP_S:
            self.frames.clear()
        self.frames.append((now, prepare(frame)))
        self.scores = [s for s in self.scores if now - s[0] <= HIT_WINDOW_S]
        pair = closest_pair(people)
        if pair is None:
            return None
        ready = len(self.frames) == CLIP_LEN and now - self.frames[0][0] >= MIN_SPAN_S
        if not ready or now - self.last < INTERVAL_S:
            return None
        self.last = now
        self.scores.append((now, self.model(normalize([f for _, f in self.frames]))))
        hits = [s for s in self.scores if s[1] >= FIGHT_PROB]
        if len(hits) < HITS or (self.emitted is not None and now - self.emitted < REPEAT_S):
            return None
        self.emitted = now
        return pair[0], pair[1], hits[0][0], float(np.mean([p for _, p in hits]))
