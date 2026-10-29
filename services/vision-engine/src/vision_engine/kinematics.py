"""目标运动：由最近 1 s 的平面坐标估计朝向与速度（TK-111），供大屏按运动方向摆放目标模型。

只用已发布的实测坐标，不预测未来位置（HYD-REQ-006 FR-102）。
"""

import math
from collections import deque

WINDOW_S = 1.0  # 估计窗口：跨越约 5 个检测周期，抵消脚点抖动
MIN_SAMPLES = 3  # 起步不足 3 帧时朝向与速度未知
STILL_MPS = 0.3  # 低于此速度视为静止：朝向由脚点抖动主导，不输出
FORGET_S = 5.0  # 超过此时长未更新的轨迹丢弃


class Motion:
    def __init__(self) -> None:
        self._history: dict[int, deque[tuple[float, float, float]]] = {}

    def update(self, key: int, t: float, x: float, y: float) -> tuple[float | None, float | None]:
        """记录 key 在单调时刻 t 的位置，返回 (朝向°, 速度 m/s)。朝向 0 为 +x、逆时针为正。"""
        history = self._history.setdefault(key, deque())
        history.append((t, x, y))
        while t - history[0][0] > WINDOW_S:
            history.popleft()
        for other in [k for k, h in self._history.items() if t - h[-1][0] > FORGET_S]:
            del self._history[other]
        if len(history) < MIN_SAMPLES:
            return None, None
        t0, x0, y0 = history[0]
        dx, dy, dt = x - x0, y - y0, t - t0
        speed = math.hypot(dx, dy) / dt
        if speed < STILL_MPS:
            return None, speed
        return math.degrees(math.atan2(dy, dx)) % 360, speed
