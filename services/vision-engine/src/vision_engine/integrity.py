"""画面可信度（TK-114）：冻结为确定性判定（FR-301、D-080）；重放、挪位与遮挡由 DINOv2 画面嵌入判定
（FR-302、FR-308）。

冻结：真实摄像头与素材都有传感器或编码噪声，相邻帧从不完全相同（实测最大像素差 7～255）；
推流源被换成定格帧时才逐帧相同。断流期间没有新帧，不由本判定处理（stream_lost 由 TK-114 发布）。

重放：每个检测帧（5 FPS）取一次整帧嵌入，保留最近 190 s（只在内存中，G-04）。每秒以最近 10 s 的
子序列与距今 30～180 s 的各历史子序列比较：两段各自去掉均值与线性趋势后求相关系数，比较的是画面
"怎样变化"而非"长什么样"——同一场景不同时刻的嵌入本就相似（实测最高 0.97），去掉后只剩运动；静止画面
只剩噪声、相关系数低，不判重放（静止由冻结判定覆盖）；缓慢的光照变化随线性趋势去掉。连续 3 次匹配到
同一历史时刻且相关系数 ≥ 0.35 判为重放。调试素材两路完整循环实测：非重放最高 0.25；重新编码、错开
采样时刻的重放最低 0.35 且全部检出，判定在重放开始后 12～22 s（设计 109 §3.3 C）。

挪位与遮挡：每路启动后前 10 s 的嵌入均值为参考画面，只在内存中，断流重连不重记（D-090）。与参考画面的
相似度低于 0.9 持续 5 s 即报一次：画面纹理消失（边缘像素极少）为遮挡，否则为挪位；恢复相似或类别改变
即重新计时。固定机位实测：正常画面与参考 ≥ 0.945，平移 10% 画面约 0.8，旋转 8° 或放大 1.3 倍约 0.88～0.9，
黑屏、纯色、严重虚焦 ≤ 0.55 且无边缘。调试素材剪接处画面整体改变，按挪位上报（D-091）。
"""

from collections import deque
from dataclasses import dataclass
from typing import Literal

import cv2
import numpy as np
import onnxruntime as ort
from numpy.lib.stride_tricks import sliding_window_view

from vision_engine.scene import MEAN, STD

FREEZE_S = 5.0  # FR-301
EMBED_INPUT = 224  # DINOv2 输入 224×224
SAMPLE_FPS = 5  # 每个检测帧取一次嵌入，与检测帧率相同
REPLAY_S = 10  # 当前子序列时长
REPLAY_MIN_AGO_S = 30  # 历史片段距今至少 30 s（FR-302）
REPLAY_HISTORY_S = 180  # 比对窗口（FR-302）
REPLAY_R = 0.35  # 相关系数阈值
REPLAY_CHECKS = 3  # 每秒检查一次，连续 3 次匹配同一历史时刻
REPLAY_TOLERANCE_S = 0.4  # "同一历史时刻"的容差：2 个采样
REPLAY_END_CHECKS = 10  # 连续 10 次不匹配视为本次重放结束，之后再匹配重新上报
REFERENCE_S = 10  # 参考画面取启动后前 10 s 的嵌入均值（D-090）
VIEW_S = 5.0  # FR-308
SHIFT_SIM = 0.9  # 与参考画面的相似度低于此值视为画面改变
EDGE_RATIO = 0.005  # 边缘像素占比低于此值为纹理消失（正常画面实测 ≥ 0.008，含夜间）
# 相邻嵌入相似度低于此值为画面切换（素材剪接处实测 -0.03～0.28，火光闪烁 0.39～0.65，其余 ≥ 0.8）
CUT_SIM = 0.5

WINDOW = REPLAY_S * SAMPLE_FPS
TREND = np.arange(WINDOW) - (WINDOW - 1) / 2  # 线性趋势的基（已去均值）
TREND_ENERGY = float(TREND @ TREND)
# 去掉均值与趋势后的平方和低于此值视为没有变化（如冻结）：相关系数记为 0，不参与比较。逐帧相同时理论上
# 为 0，舍入残差约 1e-12；调试素材实测正常画面最低 0.3
STILL_ENERGY = 1e-6 * WINDOW


class FreezeDetector:
    def __init__(self) -> None:
        self._previous: tuple[np.ndarray, float] | None = None
        self._since: float | None = None  # 本次定格的第一帧的时刻
        self._reported = False

    def update(self, frame: np.ndarray, timestamp: float) -> bool:
        """传入每个新帧；连续相同满 FREEZE_S 时返回一次 True，出现不同帧后重新计时。"""
        previous, self._previous = self._previous, (frame, timestamp)
        if previous is None or not np.array_equal(previous[0], frame):
            self._since, self._reported = None, False
            return False
        if self._since is None:
            self._since = previous[1]
        if self._reported or timestamp - self._since < FREEZE_S:
            return False
        self._reported = True
        return True


class FrameEmbedder:
    """BGR 帧 → DINOv2 CLS 嵌入（384 维、单位长度）；整帧缩放、不裁剪；多路共用一个会话。"""

    def __init__(self, session: ort.InferenceSession) -> None:
        self._session = session
        self._input = session.get_inputs()[0].name

    def __call__(self, frame: np.ndarray) -> np.ndarray:
        small = cv2.resize(frame, (EMBED_INPUT, EMBED_INPUT), interpolation=cv2.INTER_AREA)
        rgb = cv2.cvtColor(small, cv2.COLOR_BGR2RGB)
        x = ((rgb - MEAN) / STD).transpose(2, 0, 1)[None].astype(np.float32)
        cls = self._session.run(None, {self._input: x})[0][0, 0]  # last_hidden_state 的首个 token
        return cls / np.linalg.norm(cls)


def best_match(sequence: np.ndarray) -> tuple[float, int]:
    """sequence 最后 WINDOW 个嵌入为当前子序列；在起点早于它至少 REPLAY_MIN_AGO_S 的子序列中找相关系数
    最高的一段，返回 (相关系数, 起点下标)。当前子序列没有变化时返回 (0, 0)。"""
    sequence = sequence.astype(np.float64)  # float32 相减的舍入误差会让无变化的段算出非零的变化量
    current = sequence[-WINDOW:] - sequence[-WINDOW:].mean(axis=0)
    current -= np.outer(TREND, TREND @ current) / TREND_ENERGY
    norm = np.linalg.norm(current)
    if norm**2 < STILL_ENERGY:
        return 0.0, 0
    # 去均值与趋势后的当前段与两者正交：与历史段的点积不受历史段的均值与趋势影响，分母则须扣除
    end = len(sequence) - REPLAY_MIN_AGO_S * SAMPLE_FPS  # 最晚一段的起点距当前段起点 30 s
    windows = sliding_window_view(sequence[:end], WINDOW, axis=0)  # (段数, 维度, WINDOW)，不复制
    dot = np.einsum("kd,ndk->n", current, windows)
    energy = (
        np.einsum("ndk,ndk->n", windows, windows)
        - np.square(windows.sum(axis=2)).sum(axis=1) / WINDOW
        - np.square(windows @ TREND).sum(axis=1) / TREND_ENERGY
    )
    varied = energy >= STILL_ENERGY
    r = np.where(varied, dot / (np.sqrt(np.where(varied, energy, 1.0)) * norm), 0.0)
    start = int(np.argmax(r))
    return float(r[start]), start


@dataclass(frozen=True)
class Replay:
    ago_s: float  # 匹配到的历史片段距当前片段的时长
    confidence: float


class ReplayDetector:
    def __init__(self) -> None:
        size = (REPLAY_HISTORY_S + REPLAY_S) * SAMPLE_FPS
        self._embeddings: deque[np.ndarray] = deque(maxlen=size)
        self._times: deque[float] = deque(maxlen=size)
        self._count = 0
        self._matches: deque[tuple[float, float]] = deque(maxlen=REPLAY_CHECKS)  # (距今, 相关系数)
        self._misses = 0
        self._reported = False

    def update(self, embedding: np.ndarray, timestamp: float) -> Replay | None:
        """传入每个检测帧的嵌入；判定为重放时返回一次，本次重放结束后再匹配才重新上报。"""
        self._embeddings.append(embedding)
        self._times.append(timestamp)
        self._count += 1
        if (
            self._count % SAMPLE_FPS
            or len(self._embeddings) < WINDOW + REPLAY_MIN_AGO_S * SAMPLE_FPS
        ):
            return None
        sequence = np.asarray(self._embeddings)
        window = sequence[-WINDOW:]
        if np.einsum("kd,kd->k", window[1:], window[:-1]).min() < CUT_SIM:
            # 含画面切换的段不判定：切换与历史中别处的切换也相关，会匹配到错误的时刻。
            # 重放注入本身是一次切换，切换移出当前段（10 s）后再判定
            return None
        r, start = best_match(sequence)
        if r < REPLAY_R:
            self._matches.clear()
            self._misses += 1
            if self._misses >= REPLAY_END_CHECKS:
                self._reported = False
            return None
        self._misses = 0
        ago = self._times[-WINDOW] - self._times[start]
        if self._matches and abs(ago - self._matches[-1][0]) > REPLAY_TOLERANCE_S:
            self._matches.clear()
        self._matches.append((ago, r))
        if len(self._matches) < REPLAY_CHECKS or self._reported:
            return None
        self._reported = True
        ago_s, mean_r = np.mean(self._matches, axis=0)
        # 阈值处为 0.5，完全相关为 1
        return Replay(float(ago_s), min(1.0, 0.5 + (mean_r - REPLAY_R) / (2 * (1 - REPLAY_R))))


@dataclass(frozen=True)
class View:
    kind: Literal["shift", "occlusion"]
    similarity: float  # 持续期间与参考画面的平均相似度
    confidence: float


def textureless(frame: np.ndarray) -> bool:
    small = cv2.resize(frame, (320, round(320 * frame.shape[0] / frame.shape[1])))
    return (
        float((cv2.Canny(cv2.cvtColor(small, cv2.COLOR_BGR2GRAY), 50, 150) > 0).mean()) < EDGE_RATIO
    )


class ViewDetector:
    def __init__(self) -> None:
        self._samples: list[np.ndarray] = []
        self._reference: np.ndarray | None = None
        self._kind: str | None = None
        self._since = 0.0
        self._similarities: list[float] = []
        self._reported = False

    def update(self, embedding: np.ndarray, frame: np.ndarray, timestamp: float) -> View | None:
        """传入每个检测帧的嵌入与画面；同一类改变持续满 VIEW_S 时返回一次，恢复或类别改变后重新计时。"""
        if self._reference is None:
            self._samples.append(embedding)
            if len(self._samples) == REFERENCE_S * SAMPLE_FPS:
                reference = np.mean(self._samples, axis=0)
                self._reference, self._samples = reference / np.linalg.norm(reference), []
            return None
        similarity = float(embedding @ self._reference)
        kind: Literal["shift", "occlusion"] | None = None
        if similarity < SHIFT_SIM:
            kind = "occlusion" if textureless(frame) else "shift"
        if kind != self._kind:
            self._kind, self._since, self._similarities, self._reported = kind, timestamp, [], False
        if kind is None:
            return None
        self._similarities.append(similarity)
        if self._reported or timestamp - self._since < VIEW_S:
            return None
        self._reported = True
        mean = float(np.mean(self._similarities))
        # 阈值处为 0.5，相似度 0.5 及以下为 1
        return View(kind, mean, min(1.0, 0.5 + (SHIFT_SIM - mean) / (2 * (SHIFT_SIM - 0.5))))
