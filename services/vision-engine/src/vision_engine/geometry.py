"""地平面单应映射（HYD-ARCH-001 §8.1）：脚点像素 → 平面图坐标（米），附误差估计（C-CV-06）。"""

from dataclasses import dataclass
from itertools import combinations
from typing import Self

import cv2
import numpy as np

MIN_POINTS = 4  # 单应矩阵至少需要 4 组对应点（FR-902、C-CV-05）
FOOT_ERROR_RATIO = 0.05  # 脚点定位误差：上下各偏移人体框高度的 5%（C-CV-06）
MIN_AREA_PX = 1.0  # 三点围成的三角形不足 1 平方像素视为共线


def _general_position(pixels: np.ndarray) -> bool:
    """是否存在 4 个点，其中任意 3 点不共线；否则单应矩阵不唯一。"""

    def area(a: np.ndarray, b: np.ndarray, c: np.ndarray) -> float:
        (x1, y1), (x2, y2) = b - a, c - a
        return abs(float(x1 * y2 - x2 * y1)) / 2

    return any(
        all(area(*tri) >= MIN_AREA_PX for tri in combinations(quad, 3))
        for quad in combinations(pixels, MIN_POINTS)
    )


@dataclass(frozen=True)
class GroundMapping:
    homography: np.ndarray  # 3×3，像素 → 平面；已归一化为标定点处齐次坐标 w > 0
    reproj_error_m: float  # 标定点映射残差的均方根，单位米

    @classmethod
    def fit(cls, calibration: list[list[float]]) -> Self | None:
        """由标定点 [u, v, x, y] 拟合。点数不足或退化时返回 None：按未标定处理（FR-902）。"""
        points = np.asarray(calibration, dtype=np.float64).reshape(-1, 4)
        if len(points) < MIN_POINTS or not _general_position(points[:, :2]):
            return None
        homography, _ = cv2.findHomography(points[:, :2], points[:, 2:], 0)
        if homography is None or np.linalg.matrix_rank(homography) < 3:
            return None
        w = _homogeneous(points[:, :2]) @ homography[2]
        if not (np.all(w > 0) or np.all(w < 0)):
            return None  # 标定点分处地平线两侧
        homography *= np.sign(w[0])
        projected = _project(homography, points[:, :2])
        assert projected is not None  # 上面已保证 w > 0
        residuals = np.linalg.norm(projected - points[:, 2:], axis=1)
        return cls(homography, float(np.sqrt(np.mean(residuals**2))))

    def locate(self, u: float, v: float, box_h: float) -> tuple[float, float, float] | None:
        """脚点 (u, v) → (x, y, uncertainty_m)。脚点或其偏移点位于地平线以上时返回 None。"""
        delta = FOOT_ERROR_RATIO * box_h
        projected = _project(self.homography, np.array([[u, v], [u, v - delta], [u, v + delta]]))
        if projected is None:
            return None
        offset = float(np.linalg.norm(projected[1:] - projected[0], axis=1).max())
        return float(projected[0, 0]), float(projected[0, 1]), self.reproj_error_m + offset


def _project(homography: np.ndarray, pixels: np.ndarray) -> np.ndarray | None:
    """像素 → 平面；任一点位于地平线以上（w ≤ 0）时返回 None。"""
    mapped = _homogeneous(pixels) @ homography.T
    if np.any(mapped[:, 2] <= 0):
        return None
    return mapped[:, :2] / mapped[:, 2:]


def _homogeneous(pixels: np.ndarray) -> np.ndarray:
    return np.column_stack([pixels, np.ones(len(pixels))])
