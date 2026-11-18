"""单目几何自动标定：MoGe-2 从一帧画面估出度量点云，拟合地面，得到摄像头的安装高度、俯角、侧倾与水平视角。

按安装参数估算地面映射（D-102）时，参数常是人工填的默认值；安装参数自检（pose_check.py）要靠站立走动的行人当
标尺，办公室里人多半坐着，样本凑不够。这里不依赖行人：只要画面里看得到一片地面即可。

步骤（后处理与 MoGe 官方 infer() 一致，见 github.com/microsoft/MoGe moge/model/v2.py，ONNX 图里不含）：
1. 推理得到仿射不变点图、法向、有效掩码与度量尺度；
2. 在掩码内按 min |f · xy / (z + shift) − uv| 求焦距 f 与深度偏移 shift，f 即视角；
3. 按深度与内参重投影得到点云（米），x 右、y 下、z 前；
4. 法向朝上的点里先拟合最大的水平面，定出"上"的方向；再沿这个方向找最低一层有足够支撑的水平面——
   画面下部常被桌面占满，最大的水平面多是桌面而非地面；
5. 原点到地面的距离为安装高度，光轴与地面的夹角为俯角，相机 x 轴与地面的夹角为侧倾；地面点的分布给出可见范围。

尺度：单帧的度量尺度是最不稳的一项（同一画面换种缩放，高度可差 25%），但各层水平面之间的间距随之等比例变化。
地面之上有一层大面积的水平面、且间距落在桌面的范围内时，按办公桌标准高度 DESK_M 校正尺度；否则沿用模型给的尺度。
推理按几种输入设置（视觉词元数、水平翻转）各做一次，取中位数，压低单次的波动。

结果是建议值，经安装参数自检随 hyd.vision.pose_check.v1 发布，本模块不改参数。api-server 收到后把安装高度、俯角、
视角自动写回未做 4 点标定的摄像头（auto_pose.py，已标定的不改），并在摄像头设置页给出，管理员也可手动填入。
"""

import math
import threading
from dataclasses import dataclass

import cv2
import numpy as np
import onnxruntime as ort

INPUT_WIDTH = 640  # 按此宽度等比缩放后推理：CPU 约 2 s
MASK_MIN = 0.5
UP_NORMAL = -0.8  # 相机系 y 向下：法向 y 分量低于此值视为朝上的面
SAMPLES = 4096  # 求焦距与偏移时的取样点数
RANSAC_ITERS = 300
PLANE_TOL_M = 0.05
LEVEL_BIN_M = 0.05  # 沿"上"方向的高度直方图分箱
MIN_LEVEL_RATIO = 0.04  # 一层水平面的点数至少占朝上点数的此比例，才算一层（排除零星的地面杂物）
MIN_FLOOR_POINTS = 800  # 地面点少于此数不给建议：看到的地面太少，结果不可靠
SHIFT_RANGE = (-0.9, 3.0)  # 仿射点图的深度偏移搜索范围（相对单位）
# 桌面校正：地面之上第一层占朝上点数至少 DESK_RATIO 的水平面，间距（按模型尺度）在 DESK_GAP_M 内即视为桌面
DESK_M = 0.75  # GB/T 3326 办公桌高 700～760 mm
DESK_RATIO = 0.15
DESK_GAP_M = (0.45, 1.2)
DESK_FIX = (0.6, 1.7)  # 校正倍数超出此范围不校正：多半认错了层
RUNS = ((1200, False), (1800, False), (2400, False), (1800, True))  # (视觉词元数, 是否水平翻转)

_rng = np.random.default_rng(0)  # 取样与 RANSAC 固定种子：同一画面结果可复现


@dataclass(frozen=True)
class Geometry:
    height_m: float  # 摄像头离地高度
    pitch_deg: float  # 俯角，向下为负（与 pose 一致）
    roll_deg: float  # 侧倾，顺时针为正；地面映射不含侧倾，只用于提示
    hfov_deg: float  # 水平视角
    floor_width_m: float  # 可见地面的横向范围（2～98 分位）
    floor_depth_m: float  # 可见地面的纵深范围（2～98 分位）
    floor_points: int
    scale_ref: str = "model"  # model：模型给的度量尺度；desk：按桌面高度校正


def view_plane_uv(width: int, height: int) -> np.ndarray:
    """与 MoGe 的 normalized_view_plane_uv 一致：以画面对角线的一半为单位，中心为原点。"""
    aspect = width / height
    span_x, span_y = aspect / math.hypot(aspect, 1), 1 / math.hypot(aspect, 1)
    u = np.linspace(-span_x * (width - 1) / width, span_x * (width - 1) / width, width)
    v = np.linspace(-span_y * (height - 1) / height, span_y * (height - 1) / height, height)
    return np.stack(np.meshgrid(u, v), -1)


def _focal_residual(
    uv: np.ndarray, xyz: np.ndarray, shift: float, fixed: float | None = None
) -> tuple[float, float]:
    """给定偏移时的最优焦距（闭式解；fixed 给出时即用它）与残差平方和。"""
    z = xyz[:, 2] + shift
    if np.any(z <= 1e-6):
        return math.nan, math.inf
    xy = xyz[:, :2] / z[:, None]
    focal = fixed if fixed is not None else float((xy * uv).sum() / np.square(xy).sum())
    return focal, float(np.square(focal * xy - uv).sum())


def focal_of(hfov_deg: float, width: int, height: int) -> float:
    """水平视角 → 焦距（以画面对角线的一半为单位，与 recover_focal_shift 一致）。"""
    aspect = width / height
    fx = 0.5 / math.tan(math.radians(hfov_deg) / 2)  # 以画面宽为单位
    return 2 * fx * aspect / math.hypot(aspect, 1)


def recover_focal_shift(
    points: np.ndarray, mask: np.ndarray, focal: float | None = None
) -> tuple[float, float] | None:
    """仿射点图 (H, W, 3) → (焦距, 深度偏移)；焦距以画面对角线的一半为单位。有效点不足时为 None。
    focal 给出时（已知视角）只求偏移：焦距每帧自估会同时扭曲尺度与形状，已知时固定下来更稳。"""
    height, width = points.shape[:2]
    idx = np.argwhere(mask)
    if len(idx) < 16:
        return None
    idx = idx[_rng.choice(len(idx), min(SAMPLES, len(idx)), replace=False)]
    uv = view_plane_uv(width, height)[idx[:, 0], idx[:, 1]]
    xyz = points[idx[:, 0], idx[:, 1]].astype(np.float64)
    # 先在网格上粗找，再黄金分割细化；残差对偏移是单峰的
    grid = np.linspace(*SHIFT_RANGE, 80)
    costs = [_focal_residual(uv, xyz, s, focal)[1] for s in grid]
    i = int(np.argmin(costs))
    lo, hi = grid[max(i - 1, 0)], grid[min(i + 1, len(grid) - 1)]
    ratio = (math.sqrt(5) - 1) / 2
    for _ in range(40):
        a, b = hi - ratio * (hi - lo), lo + ratio * (hi - lo)
        if _focal_residual(uv, xyz, a, focal)[1] < _focal_residual(uv, xyz, b, focal)[1]:
            hi = b
        else:
            lo = a
    shift = (lo + hi) / 2
    found, cost = _focal_residual(uv, xyz, shift, focal)
    if not math.isfinite(cost) or found <= 0:
        return None
    return found, shift


def point_cloud(
    points: np.ndarray, mask: np.ndarray, scale: float, focal: float | None = None
) -> tuple[np.ndarray, np.ndarray, float] | None:
    """仿射点图 → (度量点云 (H, W, 3), 有效掩码, 水平视角度数)；focal 见 recover_focal_shift。"""
    recovered = recover_focal_shift(points, mask, focal)
    if recovered is None:
        return None
    focal, shift = recovered
    height, width = points.shape[:2]
    aspect = width / height
    fx = focal / 2 * math.hypot(aspect, 1) / aspect  # 以画面宽为单位
    fy = focal / 2 * math.hypot(aspect, 1)  # 以画面高为单位
    depth = (points[..., 2] + shift) * scale
    valid = mask & (depth > 0)
    xs = (np.arange(width) + 0.5) / width - 0.5
    ys = (np.arange(height) + 0.5) / height - 0.5
    cloud = np.stack([xs[None, :] / fx * depth, ys[:, None] / fy * depth, depth], -1)
    return cloud, valid, math.degrees(2 * math.atan(0.5 / fx))


def _fit_plane(points: np.ndarray) -> tuple[np.ndarray, float]:
    center = points.mean(0)
    normal = np.linalg.svd(points - center, full_matrices=False)[2][2]
    return normal, float(-normal @ center)


def _ransac(points: np.ndarray) -> tuple[np.ndarray, float] | None:
    best: tuple[int, np.ndarray, float] | None = None
    for _ in range(RANSAC_ITERS):
        a, b, c = points[_rng.choice(len(points), 3, replace=False)]
        n = np.cross(b - a, c - a)
        norm = float(np.linalg.norm(n))
        if norm < 1e-9:
            continue
        n = n / norm
        d = float(-n @ a)
        count = int((np.abs(points @ n + d) < PLANE_TOL_M).sum())
        if best is None or count > best[0]:
            best = (count, n, d)
    if best is None:
        return None
    _, n, d = best
    return _fit_plane(points[np.abs(points @ n + d) < PLANE_TOL_M])


@dataclass(frozen=True)
class Floor:
    """相机系下的地面：单位法向 up（朝上）与 d，地面点满足 up·p + d = 0，相机离地 d；scale 为桌面校正倍数。"""

    up: np.ndarray
    d: float
    scale: float
    scale_ref: str
    points: np.ndarray  # 地面点（已乘 scale）


@dataclass(frozen=True)
class Reconstruction:
    cloud: np.ndarray  # (H, W, 3) 米，相机系 x 右、y 下、z 前
    normals: np.ndarray
    valid: np.ndarray
    floor: Floor

    def scaled(self, factor: float, scale_ref: str) -> "Reconstruction":
        """整体缩放（以镜头为中心）：点云、地面距离与地面点同乘 factor，尺度来源记为 scale_ref。"""
        f = self.floor
        floor = Floor(f.up, f.d * factor, f.scale * factor, scale_ref, f.points * factor)
        return Reconstruction(self.cloud * factor, self.normals, self.valid, floor)


def floor_plane(cloud: np.ndarray, normals: np.ndarray, valid: np.ndarray) -> Floor | None:
    """点云 (H, W, 3)、法向 (H, W, 3)、有效掩码 → 地面；找不到足够大的地面时为 None。"""
    upward = cloud[valid & (normals[..., 1] < UP_NORMAL)]
    if len(upward) < MIN_FLOOR_POINTS:
        return None
    plane = _ransac(upward)
    if plane is None:
        return None
    up, _ = plane
    if up[1] > 0:  # 朝向相机上方（相机系 y 向下）
        up = -up
    # 沿"上"方向的高度：越低越负。取最低一层有足够支撑的水平面
    levels = upward @ up
    edges = np.arange(levels.min(), levels.max() + LEVEL_BIN_M, LEVEL_BIN_M)
    if len(edges) < 2:
        edges = np.array([levels.min(), levels.min() + LEVEL_BIN_M])
    counts, edges = np.histogram(levels, bins=edges)
    enough = np.flatnonzero(counts >= max(MIN_LEVEL_RATIO * len(upward), 50))
    if len(enough) == 0:
        return None
    floor_level = (edges[enough[0]] + edges[enough[0] + 1]) / 2
    floor = upward[np.abs(levels - floor_level) < 2 * LEVEL_BIN_M]
    if len(floor) < MIN_FLOOR_POINTS:
        return None
    normal, d = _fit_plane(floor)
    if normal @ up < 0:
        normal, d = -normal, -d
    if d <= 0:  # 平面 n·p + d = 0、n 朝上：地面点满足 n·p = −h，相机原点在平面上方 d 处
        return None
    fix, scale_ref = desk_scale(upward @ normal + d, len(upward))  # 相对拟合出的地面
    scale = fix if fix is not None else 1.0
    return Floor(normal, float(d) * scale, scale, scale_ref, floor * scale)


def ground_axes(up: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """相机系下沿地面的两个方向：前（光轴的水平分量）与右（相机 x 轴的水平分量）。"""
    forward = np.array([0.0, 0.0, 1.0]) - up[2] * up
    forward /= np.linalg.norm(forward)
    right = np.array([1.0, 0.0, 0.0]) - up[0] * up
    right -= (right @ forward) * forward
    right /= np.linalg.norm(right)
    return forward, right


def floor_geometry(
    cloud: np.ndarray, normals: np.ndarray, valid: np.ndarray, hfov_deg: float
) -> Geometry | None:
    """点云 (H, W, 3)、法向 (H, W, 3)、有效掩码 → 安装几何；找不到足够大的地面时为 None。"""
    floor = floor_plane(cloud, normals, valid)
    if floor is None:
        return None
    normal = floor.up
    # 光轴 (0,0,1) 与地面的夹角：n 朝上，低头时光轴的朝上分量为负
    pitch = math.degrees(math.asin(float(np.clip(normal[2], -1, 1))))
    roll = math.degrees(math.asin(float(np.clip(normal[0], -1, 1))))
    forward, right = ground_axes(normal)
    across, along = floor.points @ right, floor.points @ forward
    lo_x, hi_x = np.percentile(across, [2, 98])
    lo_z, hi_z = np.percentile(along, [2, 98])
    return Geometry(
        height_m=round(floor.d, 2),
        pitch_deg=round(pitch, 1),
        roll_deg=round(roll, 1),
        hfov_deg=round(hfov_deg, 1),
        floor_width_m=round(float(hi_x - lo_x), 1),
        floor_depth_m=round(float(hi_z - lo_z), 1),
        floor_points=len(floor.points),
        scale_ref=floor.scale_ref,
    )


def desk_scale(above: np.ndarray, total: int) -> tuple[float | None, str]:
    """above：各朝上点距地面的高度（模型尺度）。有一层桌面时返回把它校正为 DESK_M 的倍数。"""
    lo, hi = DESK_GAP_M
    counts, edges = np.histogram(above, bins=np.arange(lo, hi + LEVEL_BIN_M, LEVEL_BIN_M))
    if len(counts) == 0:
        return None, "model"
    # 相邻两箱合并：一层平面常跨在箱边上
    pairs = counts[:-1] + counts[1:] if len(counts) > 1 else counts
    i = int(np.argmax(pairs))
    if pairs[i] < DESK_RATIO * total:
        return None, "model"
    rough = float(
        np.median(above[(above >= edges[i]) & (above < edges[min(i + 2, len(edges) - 1)])])
    )
    level = float(np.median(above[np.abs(above - rough) < LEVEL_BIN_M]))
    fix = DESK_M / level
    if not DESK_FIX[0] <= fix <= DESK_FIX[1]:
        return None, "model"
    return fix, "desk"


def combine(results: list[Geometry], minimum: int | None = None) -> Geometry | None:
    """多次估计取中位数，尺度来源取多数。minimum 为至少需要的条数，缺省为推理设置数的一半（单次估计内合并）。"""
    if len(results) < (minimum if minimum is not None else (len(RUNS) + 1) // 2) or not results:
        return None

    def mid(field: str) -> float:
        return float(np.median([getattr(r, field) for r in results]))

    refs = [r.scale_ref for r in results]
    return Geometry(
        height_m=round(mid("height_m"), 2),
        pitch_deg=round(mid("pitch_deg"), 1),
        roll_deg=round(mid("roll_deg"), 1),
        hfov_deg=round(mid("hfov_deg"), 1),
        floor_width_m=round(mid("floor_width_m"), 1),
        floor_depth_m=round(mid("floor_depth_m"), 1),
        floor_points=int(mid("floor_points")),
        scale_ref=max(set(refs), key=refs.count),
    )


class MonocularGeometry:
    """多路共用一个会话，逐次推理（同 Segmenter，C-HW-12）。"""

    def __init__(self, session: ort.InferenceSession) -> None:
        self._session = session
        self._lock = threading.Lock()

    def estimate(self, frame: np.ndarray) -> Geometry | None:
        height, width = frame.shape[:2]
        size = (INPUT_WIDTH, round(INPUT_WIDTH * height / width))
        rgb = cv2.cvtColor(cv2.resize(frame, size, interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2RGB)
        results = [r for tokens, flip in RUNS if (r := self._once(rgb, tokens, flip)) is not None]
        return combine(results)

    def reconstruct(
        self,
        frame: np.ndarray,
        hfov_deg: float | None = None,
        exclude: np.ndarray | None = None,
    ) -> Reconstruction | None:
        """场景生成用：一次推理的度量点云（已按桌面校正尺度）、有效掩码与地面；看不到地面时为 None。
        hfov_deg 为已知水平视角（安装参数，与人员定位所用一致），给出时焦距固定为它；
        exclude 为画面尺寸的布尔掩码，其中的像素（行人、车辆）不计入点云。"""
        height, width = frame.shape[:2]
        size = (INPUT_WIDTH, round(INPUT_WIDTH * height / width))
        rgb = cv2.cvtColor(cv2.resize(frame, size, interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2RGB)
        focal = focal_of(hfov_deg, *size) if hfov_deg is not None and 0 < hfov_deg < 180 else None
        built = self._infer(rgb, RUNS[1][0], focal)
        if built is None:
            return None
        cloud, normals, valid, _ = built
        if exclude is not None:
            hidden = cv2.resize(
                exclude.astype(np.uint8), valid.shape[::-1], interpolation=cv2.INTER_NEAREST
            )
            valid = valid & ~hidden.astype(bool)
        floor = floor_plane(cloud, normals, valid)
        if floor is None:
            return None
        return Reconstruction(cloud * floor.scale, normals, valid, floor)

    def _infer(
        self, rgb: np.ndarray, tokens: int, focal: float | None = None
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray, float] | None:
        image = rgb.astype(np.float32) / 255
        with self._lock:
            points, normals, mask, scale = self._session.run(
                None,
                {
                    "image": np.ascontiguousarray(image.transpose(2, 0, 1)[None]),
                    "num_tokens": np.array(tokens, np.int64),
                },
            )
        built = point_cloud(points[0], mask[0] > MASK_MIN, float(scale[0]), focal)
        if built is None:
            return None
        cloud, valid, hfov = built
        return cloud, normals[0], valid, hfov

    def _once(self, rgb: np.ndarray, tokens: int, flip: bool) -> Geometry | None:
        built = self._infer(np.ascontiguousarray(rgb[:, ::-1]) if flip else rgb, tokens)
        if built is None:
            return None
        cloud, normals, valid, hfov = built
        found = floor_geometry(cloud, normals, valid, hfov)
        if found is not None and flip:  # 翻转后侧倾反号
            found = Geometry(**{**found.__dict__, "roll_deg": -found.roll_deg})
        return found
