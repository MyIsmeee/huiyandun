"""地平面单应映射（architecture.md §8）：脚点像素 → 平面坐标（米），附误差估计（C-CV-06）。

有 4 组以上标定点时按标定拟合；否则按安装参数以针孔模型估算（D-102）。"""

from dataclasses import dataclass
from itertools import combinations
from typing import Any, Self

import cv2
import numpy as np

MIN_POINTS = 4  # 单应矩阵至少需要 4 组对应点（FR-902、C-CV-05）
FOOT_ERROR_RATIO = 0.05  # 脚点定位误差：上下各偏移人体框高度的 5%（C-CV-06）
MIN_AREA_PX = 1.0  # 三点围成的三角形不足 1 平方像素视为共线
ESTIMATE_ERROR_RATIO = 0.1  # 按安装参数估算时，误差另加与摄像头水平距离的 10%（D-102）
MAX_GROUND_M = 500.0  # 估算时取样点的落地距离上限：接近地平线的视线落点不稳定


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
    camera_xy: tuple[float, float] | None = None  # 按安装参数估算时为摄像头平面位置，误差随距离加大

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

    @classmethod
    def from_pose(cls, pose: dict[str, Any], width: int, height: int) -> Self | None:
        """按安装高度、朝向（平面 +x 起逆时针）、俯角（向下为负）与水平视场角估算（D-102）。
        画面中心为主点，像素为正方形；取画面下半部的网格点求视线与地面的交点后拟合。"""
        yaw, pitch = np.radians(pose["yaw_deg"]), np.radians(pose["pitch_deg"])
        h = float(pose["height_m"])
        f_px = (width / 2) / np.tan(np.radians(pose["hfov_deg"]) / 2)
        forward = np.array(
            [np.cos(pitch) * np.cos(yaw), np.cos(pitch) * np.sin(yaw), np.sin(pitch)]
        )
        right = np.array([np.sin(yaw), -np.cos(yaw), 0.0])
        down = np.cross(forward, right)
        us, vs = np.meshgrid(np.linspace(0, width, 5), np.linspace(height / 2, height, 5))
        pixels = np.column_stack([us.ravel(), vs.ravel()])
        rays = (
            forward
            + np.outer((pixels[:, 0] - width / 2) / f_px, right)
            + np.outer((pixels[:, 1] - height / 2) / f_px, down)
        )
        valid = rays[:, 2] < -1e-6
        t = np.where(valid, -h / np.where(valid, rays[:, 2], -1), 0.0)  # 不落地的视线由 keep 剔除
        ground = np.array([pose["x"], pose["y"]]) + rays[:, :2] * t[:, None]
        keep = valid & (np.linalg.norm(ground - [pose["x"], pose["y"]], axis=1) < MAX_GROUND_M)
        if keep.sum() < MIN_POINTS or not _general_position(pixels[keep]):
            return None
        homography, _ = cv2.findHomography(pixels[keep], ground[keep], 0)
        if homography is None:
            return None
        homography *= np.sign(_homogeneous(pixels[keep][:1]) @ homography[2])[0]
        return cls(homography, 0.0, (float(pose["x"]), float(pose["y"])))

    def locate(self, u: float, v: float, box_h: float) -> tuple[float, float, float] | None:
        """脚点 (u, v) → (x, y, uncertainty_m)。脚点或其偏移点位于地平线以上时返回 None。"""
        delta = FOOT_ERROR_RATIO * box_h
        projected = _project(self.homography, np.array([[u, v], [u, v - delta], [u, v + delta]]))
        if projected is None:
            return None
        offset = float(np.linalg.norm(projected[1:] - projected[0], axis=1).max())
        x, y = float(projected[0, 0]), float(projected[0, 1])
        error = self.reproj_error_m + offset
        if self.camera_xy is not None:
            error += ESTIMATE_ERROR_RATIO * float(
                np.hypot(x - self.camera_xy[0], y - self.camera_xy[1])
            )
        return x, y, error

    def to_plane(self, pixels: np.ndarray) -> np.ndarray:
        """像素 (N, 2) → 平面 (N, 2)；位于地平线以上（w ≤ 0）的点为 NaN。"""
        mapped = _homogeneous(pixels) @ self.homography.T
        w = mapped[:, 2:]
        return np.where(w > 0, mapped[:, :2] / np.where(w > 0, w, 1), np.nan)


def _project(homography: np.ndarray, pixels: np.ndarray) -> np.ndarray | None:
    """像素 → 平面；任一点位于地平线以上（w ≤ 0）时返回 None。"""
    mapped = _homogeneous(pixels) @ homography.T
    if np.any(mapped[:, 2] <= 0):
        return None
    return mapped[:, :2] / mapped[:, 2:]


def _homogeneous(pixels: np.ndarray) -> np.ndarray:
    return np.column_stack([pixels, np.ones(len(pixels))])
