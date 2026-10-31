"""画面冻结判定（FR-301、D-080）：相邻帧逐像素相同持续 5 s 即为冻结。

真实摄像头与素材都有传感器或编码噪声，相邻帧从不完全相同（实测最大像素差 7～255）；
推流源被换成定格帧时才逐帧相同。断流期间没有新帧，不由本判定处理（stream_lost 由 TK-114 发布）。
"""

import numpy as np

FREEZE_S = 5.0  # FR-301


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
