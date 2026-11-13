"""目标位置的画面取点（FR-911、C-CV-06）：人员取站立的脚点，车辆取车身投影中心。

人员：脚踝可见时取脚踝下方；脚踝被挡而肩、髋可见且直立时按身体比例由髋向下推算，比例按轨迹学习；
都不可用时取框底边中点。车辆：框底边中点映射到地面后，沿视线向远处外移车身在该方向投影长度的一半。
"""

import numpy as np

from vision_engine.behavior import ANKLES, HIPS, KEYPOINT_MIN, SHOULDERS

FOOT_ERROR_RATIO = 0.05  # 脚踝或框底取点的上下误差：框高的 5%（C-CV-06）
ANKLE_LIFT_RATIO = 0.04  # 脚踝离地约为身高的 4%：脚点取脚踝下方 4% 框高
TORSO_ERROR_RATIO = 0.4  # 由肩髋推算的上下误差：躯干长的 40%，覆盖站姿与坐姿之差的大半
DEFAULT_RATIO = 1.45  # 髋到脚点 / 躯干长：实测"髋到脚踝 / 躯干"中位约 1.35，加脚踝离地
RATIO_RANGE = (0.6, 2.0)
RATIO_ALPHA = 0.2  # 按轨迹学习比例的指数滑动平均系数
RATIO_FORGET_S = 5.0  # 轨迹超过此时长未出现即丢弃学到的比例
UPRIGHT_MIN_RATIO = 0.15  # 直立：躯干竖直分量 ≥ 框高的 15%，且大于水平分量

# 车身长、宽（米），按类别取常用值
VEHICLE_SIZE_M = {
    "car": (4.5, 1.8),
    "bus": (12.0, 2.5),
    "truck": (8.0, 2.5),
    "motorcycle": (1.8, 0.6),
    "bicycle": (1.8, 0.6),
}
VEHICLE_ERROR_RATIO = 0.25  # 接地点误差另加外移量的 25%：车辆实际尺寸与朝向的不确定


def _mean(keypoints: np.ndarray, scores: np.ndarray, idx: tuple[int, ...]) -> np.ndarray | None:
    """各点均可见时返回均值点，否则 None。"""
    if np.any(scores[list(idx)] < KEYPOINT_MIN):
        return None
    return keypoints[list(idx)].mean(axis=0)


class PersonFooting:
    """人员脚点；按轨迹学习"髋到脚点 / 躯干长"，状态只在本路串行调用中使用。"""

    def __init__(self) -> None:
        self._ratios: dict[int, tuple[float, float]] = {}  # 轨迹 → (比例, 最近出现的时刻)

    def foot(
        self,
        track_id: int,
        box: tuple[float, float, float, float],
        keypoints: np.ndarray,
        scores: np.ndarray,
        t: float,
    ) -> tuple[float, float, float]:
        """画面上的脚点 (u, v) 与上下误差 δv（像素）。keypoints 为 (17, 2) 像素坐标。"""
        self._ratios = {k: r for k, r in self._ratios.items() if t - r[1] <= RATIO_FORGET_S}
        x1, _, x2, y2 = box
        box_h = y2 - box[1]
        learned = self._ratios.get(track_id)
        ratio = DEFAULT_RATIO if learned is None else learned[0]
        torso = self._upright_torso(keypoints, scores, box_h)
        visible = [i for i in ANKLES if scores[i] >= KEYPOINT_MIN]
        if visible:
            u = float(keypoints[visible, 0].mean())
            v = float(keypoints[visible, 1].max()) + ANKLE_LIFT_RATIO * box_h
            if torso is not None:
                hip_v, length = torso
                sample = (v - hip_v) / length
                ratio = sample if learned is None else ratio + RATIO_ALPHA * (sample - ratio)
            result = (u, v, FOOT_ERROR_RATIO * box_h)
        elif torso is not None:
            hips = _mean(keypoints, scores, HIPS)
            assert hips is not None  # _upright_torso 已要求双髋可见
            hip_v, length = torso
            result = (float(hips[0]), hip_v + ratio * length, TORSO_ERROR_RATIO * length)
        else:
            result = ((x1 + x2) / 2, y2, FOOT_ERROR_RATIO * box_h)
        self._ratios[track_id] = (float(np.clip(ratio, *RATIO_RANGE)), t)
        return result

    @staticmethod
    def _upright_torso(
        keypoints: np.ndarray, scores: np.ndarray, box_h: float
    ) -> tuple[float, float] | None:
        """直立时返回 (髋中点 v, 躯干长)；躯干长取肩中点到髋中点的竖直距离。"""
        shoulders = _mean(keypoints, scores, SHOULDERS)
        hips = _mean(keypoints, scores, HIPS)
        if shoulders is None or hips is None:
            return None
        du, dv = np.abs(hips[0] - shoulders[0]), hips[1] - shoulders[1]
        if dv < UPRIGHT_MIN_RATIO * box_h or dv <= du:
            return None
        return float(hips[1]), float(dv)


def vehicle_offset(object_class: str, heading_deg: float | None, outward: np.ndarray) -> np.ndarray:
    """由近端点到车身中心的地面位移（米）：沿视线方向 outward（单位向量）外移车身投影长度的一半。
    投影长度 = 长·|cos θ| + 宽·|sin θ|，θ 为车头朝向与视线的夹角；尚无朝向时取长、宽的平均。"""
    length, width = VEHICLE_SIZE_M[object_class]
    if heading_deg is None:
        extent = (length + width) / 2
    else:
        h = np.radians(heading_deg)
        along = np.array([np.cos(h), np.sin(h)])
        cos = float(along @ outward)
        sin = float(along[0] * outward[1] - along[1] * outward[0])
        extent = length * abs(cos) + width * abs(sin)
    return np.asarray(outward) * extent / 2
