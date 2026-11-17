"""三维场景初稿：分割给出每个像素是什么，单目几何（monocular.py）给出它在哪里，直接量出环境的真实尺寸。

旧做法（scene.py 的平面投影）只看各类别区域的下边缘、按类别默认尺寸补出底面，安装参数一错，位置与大小成倍偏离；
物体的长宽、朝向、高度也都是猜的。这里改为按点云测量：
- 地面类别：贴地的点投到平面上栅格化，取外轮廓；
- 立面类别（墙、围栏、栏杆、黑板）：离地 0.2 m 以上的点投到平面，逐条拟合直线（RANSAC），按间断分段，
  高度取实测的上沿（看不到上沿时不低于类别默认值）；
- 物体类别（桌、椅、柜、沙发、床等）：点投到平面后按栅格连通聚类，一簇即一件（或一组相连的）家具，
  底面取最小外接矩形，高度取实测；只看到正面的（如柜子）向远离摄像头一侧补足类别默认进深；
- 植被：取最低点的平面位置，高度实测。
室内按"横平竖直"整理：由墙的方向估出主方向，偏差在 SNAP_DEG 内的墙与家具贴齐主方向或其垂直方向。
点云在物体边缘有"飞点"（深度在前后景之间插值），按深度突变剔除，各类别区域先腐蚀一圈，免得把家具量大。
摄像头的安装高度、俯角不参与（点云自带）；只用登记的平面位置与朝向把相机系转到平面坐标，所以参数填错也不影响场景。
输出与 scene.py 相同的 SceneFrame 结构，前端不变。
"""

from typing import Any

import cv2
import numpy as np

from vision_engine.monocular import Reconstruction, ground_axes
from vision_engine.scene import (
    ADE20K,
    MAX_POLYGONS,
    MIN_AREA_M2,
    MIN_LENGTH_M,
    OBJECT_SIZE_M,
    SURFACES,
    TREE_HEIGHT_M,
    WALL_HEIGHT_M,
    _area,
    _round,
    _simplify,
    label,
)

CELL_M = 0.2  # 平面栅格边长
MIN_POINTS = 150  # 一个区域至少的点数（640×360 点云）
FLOOR_TOL_M = 0.15  # 地面类别的点离地不超过此值
ABOVE_FLOOR_M = 0.05  # 物体的点至少高出地面此值
MAX_HEIGHT_M = 3.0  # 高于此的点（天花板、灯）不计入物体与墙脚
WALL_MIN_H, WALL_MAX_H = 0.2, 3.5
LINE_TOL_M = 0.15
LINE_MIN_POINTS = 200
MAX_LINES = 8
LINE_GAP_M = 1.0  # 同一直线上的点间断超过此值即分成两段
OBJECT_MIN_DEPTH_RATIO = 0.5  # 底面短边不足默认进深的一半：只看到正面，补足进深
OBJECT_SIZE_LIMIT_M = 6.0  # 长边超过此值的簇多半是把整排桌子连在一起，仍保留，只截断尺寸异常的
HEIGHT_RANGE_M = (0.3, 2.4)
FLYING_RATIO = 0.04  # 相邻像素深度相差超过自身深度的此比例即为边缘飞点
ERODE_PX = 2
WALL_NORMAL_MAX = 0.3  # 墙面法向与"上"的夹角余弦不超过此值：近乎竖直的面
WALL_BAND_M = 0.4  # 拟合出一条墙后，其两侧此距离内的点一并移除，免得同一面墙拟合成几条平行线
MERGE_ANGLE_DEG, MERGE_GAP_M = 10.0, 0.5
SNAP_DEG = 20.0

WALLS = list(WALL_HEIGHT_M)
OBJECTS = list(OBJECT_SIZE_M)
_rng = np.random.default_rng(0)


class Projector:
    """相机系点 → (平面坐标 (N, 2), 离地高度 (N,))。平面约定同 GroundMapping.from_pose：
    前方为 (cos yaw, sin yaw)，画面右方为 (−sin yaw, cos yaw)。"""

    def __init__(self, rec: Reconstruction, pose: dict[str, Any]) -> None:
        self._up, self._d = rec.floor.up, rec.floor.d
        self._forward, self._right = ground_axes(rec.floor.up)
        yaw = np.radians(pose["yaw_deg"])
        self._ahead = np.array([np.cos(yaw), np.sin(yaw)])
        self._side = np.array([-np.sin(yaw), np.cos(yaw)])
        self.camera = np.array([pose["x"], pose["y"]], dtype=np.float64)

    def __call__(self, points: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        along, across = points @ self._forward, points @ self._right
        plane = self.camera + np.outer(along, self._ahead) + np.outer(across, self._side)
        return plane, points @ self._up + self._d


def layout(
    labels: np.ndarray, rec: Reconstruction, pose: dict[str, Any]
) -> dict[str, list[dict[str, Any]]]:
    """labels：分割的类别网格（任意分辨率，按最近邻放大到点云尺寸）。"""
    height, width = rec.valid.shape
    grid = cv2.resize(labels, (width, height), interpolation=cv2.INTER_NEAREST)
    project = Projector(rec, pose)
    reach = float(pose.get("range_m", 15.0))
    solid = rec.valid & ~_flying(rec.cloud[..., 2])
    upness = np.abs(rec.normals @ _camera_up(rec))
    kernel = np.ones((2 * ERODE_PX + 1, 2 * ERODE_PX + 1), np.uint8)
    plane, above, vertical = {}, {}, {}
    for name in ADE20K:
        region = cv2.erode((grid == label(name)).astype(np.uint8), kernel).astype(bool)
        mask = region & solid
        if mask.sum() < MIN_POINTS:
            continue
        p, h = project(rec.cloud[mask])
        near = np.linalg.norm(p - project.camera, axis=1) <= reach
        plane[name], above[name] = p[near], h[near]
        vertical[name] = upness[mask][near] <= WALL_NORMAL_MAX

    polygons: list[tuple[float, str, dict[str, Any]]] = []
    for name in SURFACES:
        if name in plane:
            flat = np.abs(above[name]) <= FLOOR_TOL_M
            for outline in _outlines(plane[name][flat]):
                polygons += _polygon("surfaces", name, outline)
    found_lines: list[tuple[str, np.ndarray, float]] = []
    for name in WALLS:
        if name not in plane:
            continue
        keep = (above[name] >= WALL_MIN_H) & (above[name] <= WALL_MAX_H) & vertical[name]
        found_lines += [
            (name, line, top) for line, top in _lines(plane[name][keep], above[name][keep])
        ]
    dominant = _dominant([line for _, line, _ in found_lines])
    walls = []
    for name, line, top in _merge(found_lines, dominant):
        walls.append(
            {
                "class": name,
                "line": _round(line),
                "height_m": round(
                    max(top, WALL_HEIGHT_M[name]) if name != "board" else WALL_HEIGHT_M[name], 2
                ),
            }
        )
    for name, (depth, _) in OBJECT_SIZE_M.items():
        if name not in plane:
            continue
        keep = (above[name] >= ABOVE_FLOOR_M) & (above[name] <= MAX_HEIGHT_M)
        for cluster, heights in _clusters(plane[name][keep], above[name][keep]):
            footprint = _footprint(cluster, project.camera, depth, dominant)
            top = float(np.clip(np.percentile(heights, 95), *HEIGHT_RANGE_M))
            item = {"class": name, "polygon": _round(footprint), "height_m": round(top, 2)}
            if (area := _area(footprint)) >= MIN_AREA_M2:
                polygons.append((area, "objects", item))
    trees = []
    for name, tree_h in TREE_HEIGHT_M.items():
        if name not in plane:
            continue
        for cluster, heights in _clusters(plane[name], above[name]):
            base = cluster[heights <= np.percentile(heights, 10)].mean(axis=0)
            top = max(float(np.percentile(heights, 95)), 0.5)
            trees.append(
                {
                    "x": round(float(base[0]), 2),
                    "y": round(float(base[1]), 2),
                    "height_m": round(min(top, tree_h * 2), 2),
                }
            )
    polygons.sort(key=lambda p: -p[0])
    scene: dict[str, list[dict[str, Any]]] = {
        "surfaces": [],
        "walls": walls,
        "objects": [],
        "trees": trees,
        "markings": [],
    }
    for _, kind, item in polygons[:MAX_POLYGONS]:
        scene[kind].append(item)
    return scene


def _camera_up(rec: Reconstruction) -> np.ndarray:
    return rec.floor.up


def _flying(depth: np.ndarray) -> np.ndarray:
    """深度突变处（前后景交界）的像素。"""
    finite = np.where(np.isfinite(depth), depth, 0.0)
    dz = np.maximum(
        np.abs(np.diff(finite, axis=0, append=finite[-1:])),
        np.abs(np.diff(finite, axis=1, append=finite[:, -1:])),
    )
    return dz > FLYING_RATIO * np.maximum(finite, 1e-6)


def _angle(direction: np.ndarray) -> float:
    return float(np.degrees(np.arctan2(direction[1], direction[0])))


def _dominant(lines: list[np.ndarray]) -> float | None:
    """墙的主方向（度，模 90）：按长度加权，在 0～90° 的圆周上取均值。"""
    if not lines:
        return None
    vectors = []
    for line in lines:
        d = line[-1] - line[0]
        length = float(np.linalg.norm(d))
        a = np.radians(_angle(d) * 4)  # 模 90° 的方向映到整圆
        vectors.append(length * np.array([np.cos(a), np.sin(a)]))
    total = np.sum(vectors, axis=0)
    if np.linalg.norm(total) < 1e-6:
        return None
    return float(np.degrees(np.arctan2(total[1], total[0])) / 4)


def _snap(angle: float, dominant: float | None) -> float:
    """把方向贴齐主方向或其垂直方向（相差不超过 SNAP_DEG 时）。"""
    if dominant is None:
        return angle
    delta = (angle - dominant + 45) % 90 - 45
    return angle - delta if abs(delta) <= SNAP_DEG else angle


def _merge(
    lines: list[tuple[str, np.ndarray, float]], dominant: float | None
) -> list[tuple[str, np.ndarray, float]]:
    """贴齐主方向后，同类、方向相近、相距不超过 MERGE_GAP_M 的墙合并为一条（取两者的总跨度）。"""
    snapped = []
    for name, line, top in lines:
        center = line.mean(axis=0)
        half = np.linalg.norm(line[-1] - line[0]) / 2
        theta = np.radians(_snap(_angle(line[-1] - line[0]), dominant))
        direction = np.array([np.cos(theta), np.sin(theta)])
        snapped.append([name, center, direction, -half, half, top])
    merged = True
    while merged:
        merged = False
        for i in range(len(snapped)):
            for j in range(i + 1, len(snapped)):
                a, b = snapped[i], snapped[j]
                cos = abs(float(a[2] @ b[2]))
                offset = b[1] - a[1]
                normal = np.array([-a[2][1], a[2][0]])
                if (
                    a[0] == b[0]
                    and cos >= np.cos(np.radians(MERGE_ANGLE_DEG))
                    and abs(float(offset @ normal)) <= MERGE_GAP_M
                ):
                    along = float(offset @ a[2])
                    sign = 1.0 if a[2] @ b[2] >= 0 else -1.0
                    lo = min(a[3], along + min(sign * b[3], sign * b[4]))
                    hi = max(a[4], along + max(sign * b[3], sign * b[4]))
                    a[3], a[4], a[5] = lo, hi, max(a[5], b[5])
                    del snapped[j]
                    merged = True
                    break
            if merged:
                break
    return [(name, np.array([c + lo * d, c + hi * d]), top) for name, c, d, lo, hi, top in snapped]


def _raster(points: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """平面点 → (栅格计数图, 原点)；栅格边长 CELL_M。"""
    origin = points.min(axis=0) - CELL_M
    idx = np.floor((points - origin) / CELL_M).astype(int)
    shape = idx.max(axis=0) + 2
    counts = np.zeros((shape[1], shape[0]), np.int32)
    np.add.at(counts, (idx[:, 1], idx[:, 0]), 1)
    return counts, origin


def _outlines(points: np.ndarray) -> list[np.ndarray]:
    """地面点的外轮廓（平面坐标）；闭运算填补家具遮挡留下的小洞。"""
    if len(points) < MIN_POINTS:
        return []
    counts, origin = _raster(points)
    mask = cv2.morphologyEx(
        (counts > 0).astype(np.uint8), cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8)
    )
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    return [origin + (c[:, 0] + 0.5) * CELL_M for c in contours if cv2.contourArea(c) >= 3]


def _clusters(points: np.ndarray, heights: np.ndarray) -> list[tuple[np.ndarray, np.ndarray]]:
    """按平面栅格的 8 连通聚类；点数不足的簇（多为分割的零星误判）丢弃。"""
    if len(points) < MIN_POINTS:
        return []
    counts, origin = _raster(points)
    occupied = (counts >= 2).astype(np.uint8)
    n, components = cv2.connectedComponents(occupied, connectivity=8)
    idx = np.floor((points - origin) / CELL_M).astype(int)
    owner = components[idx[:, 1], idx[:, 0]]
    found = []
    for k in range(1, n):
        member = owner == k
        if member.sum() >= MIN_POINTS:
            found.append((points[member], heights[member]))
    return found


def _footprint(
    points: np.ndarray, camera: np.ndarray, depth: float, dominant: float | None = None
) -> np.ndarray:
    """底面：剔除离群点后的最小外接矩形（朝向贴齐主方向时按该朝向取 5～95 分位范围）；
    短边不足默认进深的一半时，向远离摄像头一侧补足。"""
    center = np.median(points, axis=0)
    spread = np.linalg.norm(points - center, axis=1)
    core = points[spread <= np.percentile(spread, 95)]
    (cx, cy), (w, h), angle = cv2.minAreaRect(core.astype(np.float32))
    snapped = _snap(angle, dominant)
    if snapped != angle:
        angle = snapped
        theta = np.radians(angle)
        axes = np.array([[np.cos(theta), np.sin(theta)], [-np.sin(theta), np.cos(theta)]])
        local = core @ axes.T
        lo, hi = np.percentile(local, 5, axis=0), np.percentile(local, 95, axis=0)
        w, h = (hi - lo).tolist()
        cx, cy = ((lo + hi) / 2) @ axes
    w, h = min(w, OBJECT_SIZE_LIMIT_M), min(h, OBJECT_SIZE_LIMIT_M)
    if min(w, h) < OBJECT_MIN_DEPTH_RATIO * depth:
        # 补足的方向：矩形短边方向上远离摄像头的一侧
        theta = np.radians(angle)
        axis_w = np.array([np.cos(theta), np.sin(theta)])
        axis_h = np.array([-np.sin(theta), np.cos(theta)])
        short_axis = axis_w if w < h else axis_h
        away = np.array([cx, cy]) - camera
        sign = 1.0 if short_axis @ away >= 0 else -1.0
        grow = depth - min(w, h)
        cx, cy = np.array([cx, cy]) + sign * short_axis * grow / 2
        if w < h:
            w = depth
        else:
            h = depth
    return cv2.boxPoints(((float(cx), float(cy)), (float(w), float(h)), angle)).astype(np.float64)


def _lines(points: np.ndarray, heights: np.ndarray) -> list[tuple[np.ndarray, float]]:
    """立面点 → 墙脚线段与实测上沿：逐条 RANSAC 拟合直线，按间断分段。"""
    found: list[tuple[np.ndarray, float]] = []
    remaining = np.ones(len(points), bool)
    for _ in range(MAX_LINES):
        idx = np.flatnonzero(remaining)
        if len(idx) < LINE_MIN_POINTS:
            break
        best: np.ndarray | None = None
        for _ in range(200):
            a, b = points[_rng.choice(idx, 2, replace=False)]
            direction = b - a
            length = float(np.linalg.norm(direction))
            if length < 0.3:
                continue
            normal = np.array([-direction[1], direction[0]]) / length
            inliers = idx[np.abs((points[idx] - a) @ normal) < LINE_TOL_M]
            if best is None or len(inliers) > len(best):
                best = inliers
        if best is None or len(best) < LINE_MIN_POINTS:
            break
        member = points[best]
        center = member.mean(axis=0)
        direction = np.linalg.svd(member - center, full_matrices=False)[2][0]
        normal = np.array([-direction[1], direction[0]])
        band = idx[np.abs((points[idx] - center) @ normal) < WALL_BAND_M]
        remaining[band] = False
        along = (member - center) @ direction
        order = np.argsort(along)
        along, tops = along[order], heights[best][order]
        breaks = np.flatnonzero(np.diff(along) > LINE_GAP_M) + 1
        for seg, top in zip(np.split(along, breaks), np.split(tops, breaks), strict=True):
            if len(seg) < LINE_MIN_POINTS // 4:
                continue
            lo, hi = np.percentile(seg, [2, 98])
            if hi - lo < MIN_LENGTH_M:
                continue
            line = np.array([center + lo * direction, center + hi * direction])
            found.append((_simplify(line, closed=False), float(np.percentile(top, 98))))
    return found


def _polygon(kind: str, name: str, points: np.ndarray) -> list[tuple[float, str, dict]]:
    polygon = _simplify(points, closed=True)
    if len(polygon) < 3 or (area := _area(polygon)) < MIN_AREA_M2:
        return []
    return [(area, kind, {"class": name, "polygon": _round(polygon)})]
