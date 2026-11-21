"""骨骼动作模型（STGCN++，mmaction2 NTU60 二维骨骼，joint + bone 两路）：复核跌倒与打架。

只以关键点为输入，不看画面、不区分身份（G-04）。每路摄像头每 INTERVAL_S 对在场的人各跑一次单人片段、
对伸手可及的两人各跑一次双人片段，记下"跌倒"与"打人、踢人、推人"的概率，供 behavior.BehaviorDetector
与骨骼几何规则联合判定：规则看到倒地、模型近期看到了跌倒的动作，即可提前确认；两人贴近且模型连续认为在
打人、踢人或推人，即确认打架。

预处理对齐 mmaction2 的测试流程（PreNormalize2D → GenSkeFeat → UniformSampleFrames(100) → FormatGCNInput(2)），
另做两处适配，均在本地录制片段上核对过（models/cards/stgcnpp-ntu60-2d.md）：
- 时间：NTU 为 30 帧/秒、动作 2～4 s，本系统抽帧约 5 帧/秒；取近 WINDOW_S 内的样本按时间线性插值到 100 帧，
  使动作快慢与训练数据相当（原流程不足 100 帧时首尾循环，会把 3 s 的跌倒拉成几个周期）
- 尺度与位置：NTU 中人在 1920×1080 画面里约占 600 像素高、居中；监控画面里的人小且偏，按窗口内人体尺寸的
  稳健上限缩放到 TARGET_PX、以髋部中位位置居中。整窗共用一套缩放与平移，倒下时的位移与姿态变化得以保留
"""

import math
import threading
from collections import deque
from dataclasses import dataclass, field

import numpy as np
import onnxruntime as ort

# NTU RGB+D 60 的类别（A1～A60，按序）
NAMES = (
    "喝水", "吃东西", "刷牙", "梳头", "丢下东西", "捡起东西", "扔东西", "坐下", "站起", "拍手",
    "阅读", "写字", "撕纸", "穿外套", "脱外套", "穿鞋", "脱鞋", "戴眼镜", "摘眼镜", "戴帽子",
    "摘帽子", "欢呼", "挥手", "踢东西", "掏口袋", "单脚跳", "跳起", "打电话", "玩手机", "打字",
    "指东西", "自拍", "看表", "搓手", "点头", "摇头", "擦脸", "敬礼", "双手合十", "双手交叉",
    "打喷嚏", "踉跄", "跌倒", "捂头", "捂胸", "捂背", "捂脖子", "呕吐", "扇风", "打人",
    "踢人", "推人", "拍背", "指着人", "拥抱", "递东西", "摸口袋", "握手", "相向走", "背向走",
)  # fmt: skip
FALL = 42  # A43 跌倒
FIGHT = (49, 50, 51)  # A50 打人、A51 踢人、A52 推人

CLIP_LEN = 100  # 模型输入帧数（UniformSampleFrames clip_len）
PERSONS = 2  # 模型输入人数（FormatGCNInput num_person）；单人片段第二人补零
WINDOW_S = 3.3  # 每个片段的时长：约为 NTU 中 100 帧（30 帧/秒）
INTERVAL_S = 1.0  # 每路摄像头推理的间隔
MIN_SAMPLES = 6  # 片段内样本数下限
MIN_SPAN_S = 1.5  # 片段内样本须覆盖的时长
KEYPOINT_MIN = 0.3  # 关键点置信度低于此值视为不可见
MIN_JOINTS = 8  # 一帧可见关键点不少于此数才算骨骼完整
MIN_GOOD_RATIO = 0.6  # 片段内骨骼完整的帧占比下限：残缺骨骼（被挡、过小）会让模型输出无意义的极端值
TARGET_PX = 650.0  # 人体尺寸缩放到 NTU 1080p 画面中的此像素数
NTU_W, NTU_H = 1920.0, 1080.0
CENTER_Y = 0.1  # 髋部放在归一化画面中心略偏下（NTU 中髋部约在画面中部偏下）
PAIR_REACH = 2.5  # 两人髋部距离 / 两人躯干长度均值 的上限：伸手可及才组成双人片段
HISTORY_S = 8.0  # 每条轨迹、每对轨迹的概率保留时长
LEFT_HIP, RIGHT_HIP, LEFT_SHOULDER, RIGHT_SHOULDER = 11, 12, 5, 6

type Sample = tuple[float, np.ndarray, np.ndarray]  # (时刻, 关键点 (17, 2) 像素, 置信度 (17,))
type Pair = tuple[int, int]


MAX_BATCH = 4  # 每次推理的片段数上限：显存上限 runtime.ACTION_MEM_MB 按此实测，人多时分批


class ActionModel:
    """ONNX 会话：输入 (N, 2, 100, 17, 3)，输出 (N, 60) 两路融合的类别概率。各路摄像头共用，逐次推理
    （同 scene.Segmenter）：两路并发超出 runtime.ACTION_MEM_MB，cuDNN 执行失败并损坏整个进程的 CUDA 上下文；
    超过 MAX_BATCH 个片段时分批推理。"""

    def __init__(self, session: ort.InferenceSession) -> None:
        self._session = session
        self._input = session.get_inputs()[0].name
        self._lock = threading.Lock()

    def __call__(self, clips: np.ndarray) -> np.ndarray:
        # 每批补零到 MAX_BATCH 个片段，输入形状固定：批量在 1～4 间变化时显存池按各种形状反复切分，贴近
        # ACTION_MEM_MB 后 cuDNN 申请不到工作区、退到慢算法，一批 4 个从约 14 ms 变为 100 ms 以上
        # （2026-11-18 在 RTX 4060 上实测，人流画面每秒 13 个片段合计 200～500 ms）
        padded = np.zeros(
            (math.ceil(len(clips) / MAX_BATCH) * MAX_BATCH, *clips.shape[1:]), np.float32
        )
        padded[: len(clips)] = clips
        with self._lock:
            batches = [
                np.asarray(self._session.run(None, {self._input: padded[i : i + MAX_BATCH]})[0])
                for i in range(0, len(padded), MAX_BATCH)
            ]
        return np.concatenate(batches)[: len(clips)]


def _resample(samples: list[Sample], grid: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """按时间线性插值到 grid 上各时刻：关键点 (T, 17, 2) 与置信度 (T, 17)。"""
    t = np.array([s[0] for s in samples])
    points = np.stack([s[1] for s in samples])
    scores = np.stack([s[2] for s in samples])
    flat = points.reshape(len(t), -1)
    out = np.stack([np.interp(grid, t, flat[:, i]) for i in range(flat.shape[1])], axis=1)
    conf = np.stack([np.interp(grid, t, scores[:, j]) for j in range(scores.shape[1])], axis=1)
    return out.reshape(len(grid), -1, 2), conf


def _usable(samples: list[Sample], now: float) -> list[Sample] | None:
    recent = [s for s in samples if now - WINDOW_S < s[0] <= now]
    if len(recent) < MIN_SAMPLES or recent[-1][0] - recent[0][0] < MIN_SPAN_S:
        return None
    good = sum(int((s[2] >= KEYPOINT_MIN).sum() >= MIN_JOINTS) for s in recent)
    return recent if good >= MIN_GOOD_RATIO * len(recent) else None


def _extent(points: np.ndarray, scores: np.ndarray) -> float:
    """一帧可见关键点外框的长边（像素）；可见点太少时为 0。"""
    seen = points[scores >= KEYPOINT_MIN]
    return float(np.ptp(seen, axis=0).max()) if len(seen) >= 4 else 0.0


def clip(people: list[list[Sample]], now: float) -> np.ndarray | None:
    """近 WINDOW_S 内一人或两人的骨骼 → 模型输入 (2, 100, 17, 3)；任一人样本不足或骨骼残缺时为 None。
    两人共用同一套缩放与平移，保留彼此的相对位置。"""
    windows = [_usable(samples, now) for samples in people]
    if any(w is None for w in windows):
        return None
    start = max(w[0][0] for w in windows if w)
    end = min(w[-1][0] for w in windows if w)
    if end - start < MIN_SPAN_S:
        return None
    grid = np.linspace(start, end, CLIP_LEN)
    resampled = [_resample(w, grid) for w in windows if w]
    hips = np.concatenate([p[:, [LEFT_HIP, RIGHT_HIP]].mean(axis=1) for p, _ in resampled])
    center = np.median(hips, axis=0)
    size = max(
        float(np.percentile([_extent(p[i], c[i]) for i in range(CLIP_LEN)], 90))
        for p, c in resampled
    )
    if size <= 1.0:
        return None
    scale = TARGET_PX / size
    out = np.zeros((PERSONS, CLIP_LEN, 17, 3), np.float32)
    for m, (points, conf) in enumerate(resampled):
        # PreNormalize2D：x、y 分别按 NTU 画面的半宽、半高归一化到 [-1, 1]
        out[m, ..., 0] = (points[..., 0] - center[0]) * scale / (NTU_W / 2)
        out[m, ..., 1] = (points[..., 1] - center[1]) * scale / (NTU_H / 2) + CENTER_Y
        out[m, ..., 2] = conf
    return out


def _hip_torso(points: np.ndarray, scores: np.ndarray) -> tuple[np.ndarray, float] | None:
    if (scores[[LEFT_HIP, RIGHT_HIP, LEFT_SHOULDER, RIGHT_SHOULDER]] < KEYPOINT_MIN).any():
        return None
    hip = points[[LEFT_HIP, RIGHT_HIP]].mean(axis=0)
    torso = float(np.linalg.norm(points[[LEFT_SHOULDER, RIGHT_SHOULDER]].mean(axis=0) - hip))
    return (hip, torso) if torso > 0 else None


@dataclass
class ActionRecognizer:
    """单路摄像头的动作复核：保存近 WINDOW_S 的骨骼，每 INTERVAL_S 推理一次，保留近 HISTORY_S 的概率。"""

    model: ActionModel
    history: dict[int, deque[Sample]] = field(default_factory=dict)
    falls: dict[int, list[tuple[float, float]]] = field(
        default_factory=dict
    )  # 轨迹 → (时刻, 跌倒概率)
    fights: dict[Pair, list[tuple[float, float]]] = field(
        default_factory=dict
    )  # 两人 → (时刻, 打架概率)
    top: dict[int, tuple[str, float]] = field(
        default_factory=dict
    )  # 轨迹 → 最近一次最可能的动作，供诊断
    last: float = -math.inf

    def update(
        self, track_ids: np.ndarray, keypoints: np.ndarray, scores: np.ndarray, now: float
    ) -> None:
        for track_id, points, conf in zip(track_ids, keypoints, scores, strict=True):
            samples = self.history.setdefault(int(track_id), deque())
            samples.append((now, np.asarray(points, float), np.asarray(conf, float)))
            while samples and now - samples[0][0] > WINDOW_S:
                samples.popleft()
        self.history = {k: v for k, v in self.history.items() if v and now - v[-1][0] <= WINDOW_S}
        self.falls = _recent(self.falls, now)
        self.fights = _recent(self.fights, now)
        if now - self.last < INTERVAL_S:
            return
        self.last = now
        present = sorted(int(i) for i in track_ids if int(i) in self.history)
        singles = [(i, clip([list(self.history[i])], now)) for i in present]
        pairs = [
            ((a, b), clip([list(self.history[a]), list(self.history[b])], now))
            for a, b in self._close_pairs(present, track_ids, keypoints, scores)
        ]
        jobs = [(key, c) for key, c in [*singles, *pairs] if c is not None]
        if not jobs:
            return
        probs = self.model(np.stack([c for _, c in jobs]))
        for (key, _), p in zip(jobs, probs, strict=True):
            if isinstance(key, tuple):
                self.fights.setdefault(key, []).append((now, float(p[list(FIGHT)].sum())))
            else:
                self.falls.setdefault(key, []).append((now, float(p[FALL])))
                best = int(p.argmax())
                self.top[key] = (NAMES[best], float(p[best]))
        self.top = {k: v for k, v in self.top.items() if k in self.history}

    @staticmethod
    def _close_pairs(
        present: list[int], track_ids: np.ndarray, keypoints: np.ndarray, scores: np.ndarray
    ) -> list[Pair]:
        bodies = {
            int(i): body
            for i, p, s in zip(track_ids, keypoints, scores, strict=True)
            if int(i) in present
            and (body := _hip_torso(np.asarray(p, float), np.asarray(s, float)))
        }
        ids = sorted(bodies)
        return [
            (a, b)
            for n, a in enumerate(ids)
            for b in ids[n + 1 :]
            if float(np.linalg.norm(bodies[a][0] - bodies[b][0]))
            <= PAIR_REACH * (bodies[a][1] + bodies[b][1]) / 2
        ]

    def fall_peak(self, track_id: int, now: float, within: float) -> float:
        """近 within 秒内该轨迹跌倒概率的最大值；没有推理结果时为 0。"""
        return max((p for t, p in self.falls.get(track_id, []) if now - t <= within), default=0.0)

    def fight_hits(self, pair: Pair, now: float, within: float, threshold: float) -> int:
        """近 within 秒内这对轨迹打架概率不低于 threshold 的推理次数。"""
        return sum(1 for t, p in self.fights.get(pair, []) if now - t <= within and p >= threshold)


def _recent[K](
    scores: dict[K, list[tuple[float, float]]], now: float
) -> dict[K, list[tuple[float, float]]]:
    kept = {k: [(t, p) for t, p in v if now - t <= HISTORY_S] for k, v in scores.items()}
    return {k: v for k, v in kept.items() if v}
