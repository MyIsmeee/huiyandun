"""实景底图（态势页"实景"视图）：去除人员后的画面贴在单目几何给出的逐点三维位置上，场景里有什么就显示什么，
不受低模资产库的限制。

点云（monocular.py，已按地面映射对齐尺度，scene3d.align）按 COLS × 行数的网格取点，投到与人员相同的平面坐标
（scene3d.Projector）。相邻四点围成一格，以下情形不保留：任一点无效（行人、车辆所在处，或点云本身无效）、
在物体边缘的"飞点"上、超出识别范围或高于 MAX_HEIGHT_M（天花板挡住俯视），或格子最长边超出按距离放宽的门限
（前后景之间的深度突变，保留会拉出长条）。
画面去除行人与车辆：检测框（外扩）与分割中的人、车像素遮去后按周边修补（Telea），底图里不留人员图像（G-04）。
结果只随识别应答在内存中传递，不持久化（D-133）。
"""

import base64
from typing import Any

import cv2
import numpy as np

from vision_engine.monocular import Reconstruction
from vision_engine.scene3d import MAX_HEIGHT_M, REACH_M, Projector, _flying

COLS = 96  # 网格列数；行数按画面宽高比取，640×360 点云下约每 7 像素一点
MIN_HEIGHT_M = -0.3  # 低于地面此值的点（地面拟合误差、反光）不保留
EDGE_MIN_M = 0.25  # 格子最长边的门限下限
EDGE_RATIO = 0.12  # 门限随格子到镜头的水平距离放宽：远处相邻点本就相隔更远
IMAGE_WIDTH = 960  # 底图画面宽度（像素）
JPEG_QUALITY = 70
MASK_DILATE_PX = 9  # 人员掩码外扩：分割边缘与检测框之外的衣角、影子一并遮去
INPAINT_RADIUS_PX = 5
MOVING_ADE = (12, 20, 80, 83, 127)  # ADE20K 原始类别：person、car、bus、truck、bicycle


def _sample(height: int, width: int, rows: int, cols: int) -> tuple[np.ndarray, np.ndarray]:
    """网格点 (i, j) 取点云中画面归一化坐标 ((j + 0.5) / cols, (i + 0.5) / rows) 所在的像素。"""
    r = np.minimum(((np.arange(rows) + 0.5) * height / rows).astype(int), height - 1)
    c = np.minimum(((np.arange(cols) + 0.5) * width / cols).astype(int), width - 1)
    return r, c


def _mesh(
    rec: Reconstruction, pose: dict[str, Any], rows: int, cols: int
) -> tuple[np.ndarray, np.ndarray]:
    """网格点的（平面 x, 离地高度, 平面 y）与各格子是否保留（rows−1, cols−1）。"""
    height, width = rec.valid.shape
    r, c = _sample(height, width, rows, cols)
    solid = rec.valid & ~_flying(rec.cloud[..., 2])
    project = Projector(rec, pose)
    plane, above = project(rec.cloud[np.ix_(r, c)].reshape(-1, 3))
    points = np.column_stack([plane[:, 0], above, plane[:, 1]]).reshape(rows, cols, 3)
    reach = np.linalg.norm(plane - project.camera, axis=1).reshape(rows, cols)
    ok = (
        solid[np.ix_(r, c)]
        & (reach <= REACH_M)
        & (points[..., 1] >= MIN_HEIGHT_M)
        & (points[..., 1] <= MAX_HEIGHT_M)
    )
    corners = [points[:-1, :-1], points[:-1, 1:], points[1:, 1:], points[1:, :-1]]
    edges = [np.linalg.norm(corners[k] - corners[(k + 1) % 4], axis=-1) for k in range(4)]
    edges.append(np.linalg.norm(corners[0] - corners[2], axis=-1))  # 对角线：三角形的第三条边
    longest = np.max(edges, axis=0)
    distance = (reach[:-1, :-1] + reach[1:, 1:]) / 2
    keep = (
        ok[:-1, :-1]
        & ok[:-1, 1:]
        & ok[1:, :-1]
        & ok[1:, 1:]
        & (longest <= np.maximum(EDGE_MIN_M, EDGE_RATIO * distance))
    )
    used = np.zeros((rows, cols), bool)
    used[:-1, :-1] |= keep
    used[:-1, 1:] |= keep
    used[1:, :-1] |= keep
    used[1:, 1:] |= keep
    points[~used] = 0.0
    return points, keep


def _image(frame: np.ndarray, exclude: np.ndarray | None, ade: np.ndarray | None) -> str:
    """去除行人与车辆后的画面，JPEG 的 base64。exclude 为画面尺寸的检测框掩码，ade 为分割的原始类别网格。"""
    height, width = frame.shape[:2]
    size = (
        (IMAGE_WIDTH, round(IMAGE_WIDTH * height / width))
        if width > IMAGE_WIDTH
        else (width, height)
    )
    image = cv2.resize(frame, size, interpolation=cv2.INTER_AREA)
    mask = np.zeros(size[::-1], np.uint8)
    if exclude is not None:
        mask |= cv2.resize(exclude.astype(np.uint8), size, interpolation=cv2.INTER_NEAREST)
    if ade is not None:
        moving = np.isin(ade, MOVING_ADE).astype(np.uint8)
        mask |= cv2.resize(moving, size, interpolation=cv2.INTER_NEAREST)
    if mask.any():
        kernel = np.ones((MASK_DILATE_PX, MASK_DILATE_PX), np.uint8)
        image = cv2.inpaint(
            image, cv2.dilate(mask, kernel) * 255, INPAINT_RADIUS_PX, cv2.INPAINT_TELEA
        )
    ok, jpeg = cv2.imencode(".jpg", image, [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY])
    if not ok:
        raise ValueError("JPEG 编码失败")
    return base64.b64encode(jpeg.tobytes()).decode()


def backdrop(
    rec: Reconstruction,
    pose: dict[str, Any],
    frame: np.ndarray,
    exclude: np.ndarray | None = None,
    ade: np.ndarray | None = None,
) -> dict[str, Any] | None:
    """SceneFrame.backdrop；没有一个格子可保留时为 None。rec、pose 为对齐后的重建与位姿（scene3d.align）。"""
    height, width = rec.valid.shape
    rows = max(2, round(COLS * height / width))
    points, keep = _mesh(rec, pose, rows, COLS)
    if not keep.any():
        return None
    return {
        "cols": COLS,
        "rows": rows,
        "points": np.round(points, 2).reshape(-1).tolist(),
        "quads": base64.b64encode(np.packbits(keep.reshape(-1)).tobytes()).decode(),
        "image": _image(frame, exclude, ade),
    }
