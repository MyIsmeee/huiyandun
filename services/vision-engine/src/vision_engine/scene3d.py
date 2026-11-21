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
墙脚另取"立面像素正下方的地面像素"：地面点的深度远比墙面稀疏的点可靠，墙被家具挡住大半时也量得到墙脚。

尺度与人员对齐（align）：单帧的度量尺度最不稳（同一画面可差 25%），人员位置却按地面映射（标定点或安装参数）换算，
两者尺度不一致时人会浮在桌子外、墙外。场景生成时把点云的地面点与地面映射逐点比对，按距镜头的距离之比整体缩放、
按方位之差微调朝向，场景与人员落在同一把尺子上；比对点不足或倍数离谱（多半映射本身不成立）时保留模型尺度。
输出与 scene.py 相同的 SceneFrame 结构，前端不变。
"""

from typing import Any

import cv2
import numpy as np

from vision_engine.geometry import GroundMapping
from vision_engine.monocular import Reconstruction, ground_axes
from vision_engine.scene import (
    ADE20K,
    KINDS,
    MAX_POLYGONS,
    MIN_AREA_M2,
    MIN_LENGTH_M,
    MIN_SMALL_AREA_M2,
    OBJECT_SIZE_M,
    SMALL_AREA_CLASSES,
    SMALL_CLASSES,
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
# 小件（SMALL_CLASSES）至少的点数：分割只有 64×64 格，一格约合 56 个点，腐蚀后一台远处的显示器只剩几十个点，
# 按 MIN_POINTS 整类丢弃。腐蚀仍保留：掩码边缘会沾上背后墙面的点，不腐蚀时沿墙多出一条假物体
MIN_SMALL_POINTS = 60
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
BASE_MIN_M = 0.3  # 底部离地低于此值视为落地，不给出 base_m
FLYING_RATIO = 0.04  # 相邻像素深度相差超过自身深度的此比例即为边缘飞点
ERODE_PX = 2
WALL_NORMAL_MAX = 0.3  # 墙面法向与"上"的夹角余弦不超过此值：近乎竖直的面
WALL_BAND_M = 0.4  # 拟合出一条墙后，其两侧此距离内的点一并移除，免得同一面墙拟合成几条平行线
MERGE_ANGLE_DEG, MERGE_GAP_M = 10.0, 0.5
SNAP_DEG = 20.0
# 取点范围：远处近地平线的点深度不稳，不计入。不用摄像头的量程 range_m：它由 api-server 按上一次识别到的最远点
# 拟合（fitted_range），再拿它截断这一次的点，场景只会越识别越小、缩到一角就回不来
REACH_M = 15.0
BASE_PX = 3  # 立面像素正下方此行数（点云分辨率）内的地面像素即墙脚
ALIGN_SAMPLES = 4000  # 与地面映射比对的地面点取样数
ALIGN_MIN_POINTS = 200
ALIGN_MIN_M = 0.5  # 离镜头水平距离不足此值的点不比对：比值对误差过于敏感
ALIGN_RANGE = (0.5, 2.0)  # 缩放倍数超出此范围不对齐：多半地面映射不成立（标定点配错、安装参数离谱）
ALIGN_MAX_TURN_DEG = 30.0  # 朝向差超过此值不改朝向，只缩放

WALLS = list(WALL_HEIGHT_M)
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


def align(
    rec: Reconstruction,
    mapping: GroundMapping | None,
    pose: dict[str, Any],
    frame_size: tuple[int, int],
) -> tuple[Reconstruction, dict[str, Any], float | None]:
    """按人员所用的地面映射对齐点云：返回 (缩放后的重建, 朝向微调后的位姿, 缩放倍数)；不对齐时倍数为 None。
    frame_size 为原画面 (宽, 高)：地面映射以原画面像素为单位。"""
    if mapping is None:
        return rec, pose, None
    height, width = rec.valid.shape
    project = Projector(rec, pose)
    above = rec.cloud @ rec.floor.up + rec.floor.d
    idx = np.argwhere(rec.valid & (np.abs(above) <= FLOOR_TOL_M))
    if len(idx) < ALIGN_MIN_POINTS:
        return rec, pose, None
    idx = idx[_rng.choice(len(idx), min(ALIGN_SAMPLES, len(idx)), replace=False)]
    pixels = (idx[:, ::-1] + 0.5) * np.array([frame_size[0] / width, frame_size[1] / height])
    target = mapping.to_plane(pixels) - project.camera
    measured = project(rec.cloud[idx[:, 0], idx[:, 1]])[0] - project.camera
    a, b = np.linalg.norm(measured, axis=1), np.linalg.norm(target, axis=1)
    reach = REACH_M
    ok = np.isfinite(b) & (a >= ALIGN_MIN_M) & (b >= ALIGN_MIN_M) & (b <= reach)
    if ok.sum() < ALIGN_MIN_POINTS:
        return rec, pose, None
    factor = float(np.median(b[ok] / a[ok]))
    if not ALIGN_RANGE[0] <= factor <= ALIGN_RANGE[1]:
        return rec, pose, None
    turn = np.degrees(
        np.arctan2(target[ok, 1], target[ok, 0]) - np.arctan2(measured[ok, 1], measured[ok, 0])
    )
    turn = float(np.median((turn + 180) % 360 - 180))
    if abs(turn) > ALIGN_MAX_TURN_DEG:
        turn = 0.0
    return rec.scaled(factor, "mapping"), pose | {"yaw_deg": pose["yaw_deg"] + turn}, factor


def layout(
    labels: np.ndarray,
    rec: Reconstruction,
    pose: dict[str, Any],
    ade: np.ndarray | None = None,
) -> dict[str, list[dict[str, Any]]]:
    """labels：分割的类别网格（任意分辨率，按最近邻放大到点云尺寸）。ade：同尺寸的 ADE20K 原始类别编号，
    给出时物体带细分类别 kind（簇内点数最多的一种，见 KINDS）。"""
    height, width = rec.valid.shape
    grid = cv2.resize(labels, (width, height), interpolation=cv2.INTER_NEAREST)
    raw = None if ade is None else cv2.resize(ade, (width, height), interpolation=cv2.INTER_NEAREST)
    project = Projector(rec, pose)
    reach = REACH_M
    solid = rec.valid & ~_flying(rec.cloud[..., 2])
    upness = np.abs(rec.normals @ _camera_up(rec))
    kernel = np.ones((2 * ERODE_PX + 1, 2 * ERODE_PX + 1), np.uint8)
    plane, above, vertical, kinds = {}, {}, {}, {}
    for name in ADE20K:
        region = cv2.erode((grid == label(name)).astype(np.uint8), kernel).astype(bool)
        mask = region & solid
        if mask.sum() < (MIN_SMALL_POINTS if name in SMALL_CLASSES else MIN_POINTS):
            continue
        p, h = project(rec.cloud[mask])
        near = np.linalg.norm(p - project.camera, axis=1) <= reach
        plane[name], above[name] = p[near], h[near]
        vertical[name] = upness[mask][near] <= WALL_NORMAL_MAX
        if raw is not None:
            kinds[name] = raw[mask][near]

    polygons: list[tuple[float, str, dict[str, Any]]] = []
    for name in SURFACES:
        if name in plane:
            flat = np.abs(above[name]) <= FLOOR_TOL_M
            for outline in _outlines(plane[name][flat]):
                polygons += _polygon("surfaces", name, outline)
    found_lines: list[tuple[str, np.ndarray, float]] = []
    ground = np.isin(grid, [label(n) for n in SURFACES]) & solid
    for name in WALLS:
        points, heights = [], []
        if name in plane:
            keep = (above[name] >= WALL_MIN_H) & (above[name] <= WALL_MAX_H) & vertical[name]
            points.append(plane[name][keep])
            heights.append(above[name][keep])
        base = _wall_base(rec, ground, grid == label(name))
        if len(base):
            p, _ = project(base)
            near = np.linalg.norm(p - project.camera, axis=1) <= reach
            points.append(p[near])
            heights.append(np.zeros(int(near.sum())))  # 墙脚不参与上沿；上沿不足时取类别默认值
        if not points:
            continue
        found_lines += [
            (name, line, top)
            for line, top in _lines(np.concatenate(points), np.concatenate(heights))
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
        points, heights_all = plane[name][keep], above[name][keep]
        for member in _members(points, MIN_SMALL_POINTS if name in SMALL_CLASSES else MIN_POINTS):
            cluster, heights = points[member], heights_all[member]
            footprint = _footprint(cluster, project.camera, depth, dominant)
            top = float(np.clip(np.percentile(heights, 95), *HEIGHT_RANGE_M))
            item = {"class": name, "polygon": _round(footprint), "height_m": round(top, 2)}
            if name in kinds and (kind := _kind(kinds[name][keep][member])):
                item["kind"] = kind
            # 底部离地高度：放在桌面、柜顶上的小件物品（显示器、微波炉、纸箱）按它摆放，不落到地面。只给小件：
            # 桌子的点集中在桌面，5 分位也在桌面高度，给出会让桌子悬空
            base = float(np.percentile(heights, 5))
            if name in SMALL_CLASSES and base >= BASE_MIN_M:
                item["base_m"] = round(min(base, top - 0.05), 2)
            least = MIN_SMALL_AREA_M2 if name in SMALL_AREA_CLASSES else MIN_AREA_M2
            if (area := _area(footprint)) >= least:
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


def _wall_base(rec: Reconstruction, ground: np.ndarray, wall: np.ndarray) -> np.ndarray:
    """墙脚（相机系点 (N, 3)）：每列地面区域的上沿像素，其正上方 BASE_PX 行内是该立面时，取地面与立面交界那条
    像素边的视线与地面平面的交点。不取地面点本身：远处一行像素在地面上跨出十几厘米，墙会被拉近。
    交界边的视线由该像素与其下一像素的视线外推半个像素得到（两者都在地面上，深度可靠）。"""
    above = np.zeros_like(wall)
    for s in range(1, BASE_PX + 1):
        above[s:] |= wall[:-s]
    top = ground.copy()
    top[1:] &= ~ground[:-1]  # 上一行不是地面
    top[:-1] &= ground[1:]  # 下一行仍是地面：用于外推
    top[-1] = False
    rows, cols = np.nonzero(top & above)
    if len(rows) == 0:
        return np.empty((0, 3))
    here, below = rec.cloud[rows, cols], rec.cloud[rows + 1, cols]
    here = here / np.linalg.norm(here, axis=1, keepdims=True)
    below = below / np.linalg.norm(below, axis=1, keepdims=True)
    edge = here + (here - below) / 2
    toward = edge @ rec.floor.up
    ok = toward < -1e-6  # 视线朝下才与地面相交
    return edge[ok] * (-rec.floor.d / toward[ok])[:, None]


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
    return [(points[m], heights[m]) for m in _members(points)]


def _kind(ade: np.ndarray) -> str | None:
    """簇内点数最多的细分类别（KINDS 中没有的编号不计）。"""
    ids, counts = np.unique(ade, return_counts=True)
    named = [(int(c), KINDS[int(i)]) for i, c in zip(ids, counts, strict=True) if int(i) in KINDS]
    return max(named)[1] if named else None


def _members(points: np.ndarray, least: int = MIN_POINTS) -> list[np.ndarray]:
    """_clusters 的各簇成员（布尔掩码）；不足 least 个点的簇不计。"""
    if len(points) < least:
        return []
    counts, origin = _raster(points)
    occupied = (counts >= 2).astype(np.uint8)
    n, components = cv2.connectedComponents(occupied, connectivity=8)
    idx = np.floor((points - origin) / CELL_M).astype(int)
    owner = components[idx[:, 1], idx[:, 0]]
    found = []
    for k in range(1, n):
        member = owner == k
        if member.sum() >= least:
            found.append(member)
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
