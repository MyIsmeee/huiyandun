"""运动门控（HYD-ARCH-001 §8.1，借鉴 Frigate）：帧差得到运动区域，只把运动区域送推理。

运动区域与上一帧的轨迹框合并：静止的人（如跌倒后）没有帧差，仍须持续推理以维持轨迹。
无运动且无轨迹时返回 None，跳过推理。
"""

import cv2
import numpy as np

WIDTH = 320  # 帧差在缩小的灰度图上计算
ALPHA = 0.05  # 背景滑动平均的更新率：缓慢的光照变化并入背景
DIFF_THRESHOLD = 25  # 灰度差超过此值视为运动像素
MIN_MOTION_RATIO = 0.002  # 运动像素少于画面的 0.2% 视为噪声
PAD_RATIO = 0.2  # 区域向四周扩展其宽高的 20%，避免人体被裁切
MIN_SIZE = 640  # 区域不小于模型输入，避免把小区域放大推理


class MotionGate:
    def __init__(self) -> None:
        self._background: np.ndarray | None = None

    def region(self, frame: np.ndarray, boxes: np.ndarray) -> tuple[int, int, int, int] | None:
        """返回需要推理的区域 (x1, y1, x2, y2)；boxes 为上一帧的轨迹框（整帧坐标）。"""
        h, w = frame.shape[:2]
        scale = WIDTH / w
        gray = cv2.GaussianBlur(
            cv2.cvtColor(cv2.resize(frame, (WIDTH, round(h * scale))), cv2.COLOR_BGR2GRAY),
            (5, 5),
            0,
        ).astype(np.float32)
        if self._background is None:
            self._background = gray
            return 0, 0, w, h  # 首帧没有参照，整帧推理
        mask = cv2.absdiff(gray, self._background) > DIFF_THRESHOLD
        cv2.accumulateWeighted(gray, self._background, ALPHA)

        rects = [] if len(boxes) == 0 else [np.asarray(boxes, dtype=np.float64)]
        if mask.mean() >= MIN_MOTION_RATIO:
            x, y, mw, mh = cv2.boundingRect(mask.astype(np.uint8))
            rects.append(np.array([[x, y, x + mw, y + mh]]) / scale)
        if not rects:
            return None
        stacked = np.vstack(rects)
        (x1, y1), (x2, y2) = stacked[:, :2].min(axis=0), stacked[:, 2:].max(axis=0)
        return _expand(x1, y1, x2, y2, w, h)


def _expand(
    x1: float, y1: float, x2: float, y2: float, w: int, h: int
) -> tuple[int, int, int, int]:
    """按 PAD_RATIO 扩展并不小于 MIN_SIZE，超出画面时平移回画面内。"""
    cx, cy = (x1 + x2) / 2, (y1 + y2) / 2
    rw = min(w, max((x2 - x1) * (1 + 2 * PAD_RATIO), MIN_SIZE))
    rh = min(h, max((y2 - y1) * (1 + 2 * PAD_RATIO), MIN_SIZE))
    left = int(np.clip(cx - rw / 2, 0, w - rw))
    top = int(np.clip(cy - rh / 2, 0, h - rh))
    return left, top, int(left + rw), int(top + rh)
