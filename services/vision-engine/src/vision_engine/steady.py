"""静止人员的位置锁定：人在画面中没有动，地面位置就不应该动。

坐着的人脚踝时隐时现，脚点在"脚踝 / 由髋推算 / 框底边"之间切换（footing.py）；摄像头装得低、视线贴近地面时，
画面上差几个像素，地面位置就差半米以上，人形在场景里来回飘。这里按画面中头肩的位置判断是否在动（它们很少被桌椅挡住），
近 WINDOW_S 内头肩始终在 STILL_RATIO 倍参考尺度以内即视为不动（窗口须先攒满，慢慢走动的人不会被锁住），
不动时输出锁定期间地面位置的中位数，速度随之为 0；一旦超出即解锁，按实测位置跟随。
"""

from dataclasses import dataclass, field

import numpy as np

KEYPOINT_MIN = 0.3
UPPER = (0, 1, 2, 3, 4, 5, 6)  # 鼻、眼、耳、双肩
STILL_RATIO = 0.2  # 窗口内头肩偏离其均值不超过参考尺度的此倍数即为不动（坐着时头部晃动约几个像素）
WINDOW_S = 1.5
MIN_SCALE_PX = 8.0
KEEP = 50  # 锁定期间保留的地面位置样本数（5 FPS 下 10 s）
FORGET_S = 10.0


@dataclass
class _State:
    seen: float
    anchors: list[tuple[float, np.ndarray]] = field(
        default_factory=list
    )  # 近 WINDOW_S 的（时刻, 头肩）
    samples: list[tuple[float, float, float]] = field(default_factory=list)  # 锁定期间的地面位置
    locked_at: np.ndarray | None = (
        None  # 锁定开始时的头肩位置：累计移开超出范围即解锁（慢慢挪动不会一直被锁住）
    )


class Steady:
    """单路摄像头内各人员轨迹的锁定状态；只在该路串行调用中使用。"""

    def __init__(self) -> None:
        self._tracks: dict[int, _State] = {}

    def update(
        self,
        track_id: int,
        box: tuple[float, float, float, float],
        points: np.ndarray,
        scores: np.ndarray,
        located: tuple[float, float, float],
        t: float,
    ) -> tuple[float, float, float]:
        """返回输出的 (x, y, uncertainty)：静止时为锁定期间的中位数，否则为 located。"""
        self._tracks = {k: s for k, s in self._tracks.items() if t - s.seen <= FORGET_S}
        upper = [i for i in UPPER if scores[i] >= KEYPOINT_MIN]
        x1, y1, x2, y2 = box
        if upper:
            anchor = points[upper].mean(axis=0)
        else:
            anchor = np.array([(x1 + x2) / 2, y1])
        shoulders = [i for i in (5, 6) if scores[i] >= KEYPOINT_MIN]
        span = float(abs(points[5, 0] - points[6, 0])) if len(shoulders) == 2 else 0.0
        scale = max(span, 0.15 * (y2 - y1), MIN_SCALE_PX)
        state = self._tracks.setdefault(track_id, _State(t))
        state.seen = t
        state.anchors = [(at, p) for at, p in state.anchors if t - at <= WINDOW_S] + [(t, anchor)]
        recent = np.array([p for _, p in state.anchors])
        spread = float(np.linalg.norm(recent - recent.mean(axis=0), axis=1).max())
        filled = t - state.anchors[0][0] >= WINDOW_S * 0.8
        limit = STILL_RATIO * scale
        drifted = (
            state.locked_at is not None and float(np.linalg.norm(anchor - state.locked_at)) > limit
        )
        if not filled or spread > limit or drifted:
            state.samples, state.locked_at = [], None
            if drifted:
                state.anchors = [(t, anchor)]  # 重新攒满窗口才再锁定
            return located
        if state.locked_at is None:
            state.locked_at = anchor
        state.samples = [*state.samples, located][-KEEP:]
        xs, ys, us = (np.array(c) for c in zip(*state.samples, strict=True))
        return float(np.median(xs)), float(np.median(ys)), float(np.median(us))
