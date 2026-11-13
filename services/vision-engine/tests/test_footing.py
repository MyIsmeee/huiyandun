"""目标位置的画面取点（FR-911、C-CV-06）：人员脚点、按轨迹学习的身体比例、车辆接地点。"""

import numpy as np
import pytest

from vision_engine.footing import DEFAULT_RATIO, PersonFooting, vehicle_offset
from vision_engine.geometry import GroundMapping

BOX = (100.0, 100.0, 200.0, 500.0)  # 框高 400 像素


def person(
    shoulder_v: float = 160, hip_v: float = 280, ankle_v: float | None = 470, lying: bool = False
) -> tuple[np.ndarray, np.ndarray]:
    """17 个关键点（COCO 顺序）与置信度；ankle_v 为 None 时脚踝不可见，其余未用到的点不可见。"""
    keypoints = np.zeros((17, 2))
    scores = np.zeros(17)
    parts = {(5, 6): shoulder_v, (11, 12): hip_v}
    if ankle_v is not None:
        parts[(15, 16)] = ankle_v
    for (left, right), v in parts.items():
        keypoints[[left, right]] = [[140, v], [160, v]]
        scores[[left, right]] = 0.9
    if lying:  # 躯干水平：肩、髋在同一高度、左右排开
        keypoints[[5, 6]] = [[110, 480], [110, 490]]
        keypoints[[11, 12]] = [[180, 480], [180, 490]]
    return keypoints, scores


def test_ankle_foot() -> None:
    """A1：脚踝可见时取较低脚踝下方 4% 框高，上下误差为框高的 5%。"""
    keypoints, scores = person()
    keypoints[16, 1] = 480  # 右脚踝更低

    u, v, delta = PersonFooting().foot(1, BOX, keypoints, scores, 0.0)

    assert (u, v, delta) == pytest.approx((150, 480 + 0.04 * 400, 0.05 * 400))


def test_hidden_legs_from_torso() -> None:
    """A2：脚踝不可见、肩髋可见且直立：髋 + 1.45 × 躯干长，误差为躯干长的 40%。"""
    keypoints, scores = person(ankle_v=None)

    u, v, delta = PersonFooting().foot(1, BOX, keypoints, scores, 0.0)

    torso = 280 - 160
    assert (u, v, delta) == pytest.approx((150, 280 + DEFAULT_RATIO * torso, 0.4 * torso))


def test_ratio_learned_per_track() -> None:
    """A3：此前脚踝可见时比例为 0.9（如坐着）；脚踝被挡后按学到的比例推算，其他轨迹仍用默认值。"""
    footing = PersonFooting()
    torso = 280 - 160
    # 较低脚踝 + 0.04 × 框高 = 髋 + 0.9 × 躯干长
    seated = person(ankle_v=280 + 0.9 * torso - 0.04 * 400)
    for i in range(5):
        footing.foot(1, BOX, *seated, i / 5)

    _, v, _ = footing.foot(1, BOX, *person(ankle_v=None), 1.0)
    _, other, _ = footing.foot(2, BOX, *person(ankle_v=None), 1.0)

    assert v == pytest.approx(280 + 0.9 * torso)
    assert other == pytest.approx(280 + DEFAULT_RATIO * torso)


def test_learned_ratio_is_bounded_and_forgotten() -> None:
    """比例限 0.6～2.0；轨迹 5 s 未出现后丢弃学到的值。"""
    footing = PersonFooting()
    torso = 280 - 160
    footing.foot(1, BOX, *person(ankle_v=280 + 3 * torso), 0.0)

    _, v, _ = footing.foot(1, BOX, *person(ankle_v=None), 1.0)
    assert v == pytest.approx(280 + 2.0 * torso)

    _, v, _ = footing.foot(1, BOX, *person(ankle_v=None), 7.0)
    assert v == pytest.approx(280 + DEFAULT_RATIO * torso)


@pytest.mark.parametrize(
    "skeleton",
    [
        person(ankle_v=None, lying=True),  # 横躺：躯干水平
        (np.zeros((17, 2)), np.zeros(17)),  # 无骨骼（RF-DETR 独有的人员框）
        person(hip_v=165, ankle_v=None),  # 只露上半身一角：躯干竖直分量不足框高的 15%
    ],
)
def test_fallback_to_box_bottom(skeleton: tuple[np.ndarray, np.ndarray]) -> None:
    """A4：横躺、无骨骼等取框底边中点，误差为框高的 5%。"""
    u, v, delta = PersonFooting().foot(1, BOX, *skeleton, 0.0)

    assert (u, v, delta) == pytest.approx((150, 500, 0.05 * 400))


# 斜看车辆的摄像头：高 6 m、俯角 30°、水平视场角 90°，1280×720
POSE = {"x": 0.0, "y": 0.0, "height_m": 6.0, "yaw_deg": 0.0, "pitch_deg": -30.0, "hfov_deg": 90.0}
WIDTH, HEIGHT = 1280, 720


def project(points: np.ndarray) -> np.ndarray:
    """与 GroundMapping.from_pose 相同的针孔模型：平面坐标与高度 (N, 3) → 像素 (N, 2)。"""
    yaw, pitch = np.radians(POSE["yaw_deg"]), np.radians(POSE["pitch_deg"])
    forward = np.array([np.cos(pitch) * np.cos(yaw), np.cos(pitch) * np.sin(yaw), np.sin(pitch)])
    right = np.array([np.sin(yaw), -np.cos(yaw), 0.0])
    down = np.cross(forward, right)
    f = (WIDTH / 2) / np.tan(np.radians(POSE["hfov_deg"]) / 2)
    rel = points - [POSE["x"], POSE["y"], POSE["height_m"]]
    depth = rel @ forward
    return np.column_stack(
        [WIDTH / 2 + f * (rel @ right) / depth, HEIGHT / 2 + f * (rel @ down) / depth]
    )


def car_box(center: tuple[float, float], heading_deg: float) -> tuple[float, ...]:
    """4.5 × 1.8 × 1.5 m 的轿车在画面上的外接框。"""
    h = np.radians(heading_deg)
    along, across = np.array([np.cos(h), np.sin(h)]), np.array([-np.sin(h), np.cos(h)])
    corners = [
        [*(np.asarray(center) + a * 2.25 * along + b * 0.9 * across), z]
        for a in (-1, 1)
        for b in (-1, 1)
        for z in (0.0, 1.5)
    ]
    pixels = project(np.array(corners))
    return (*pixels.min(axis=0), *pixels.max(axis=0))


@pytest.mark.parametrize(
    ("center", "heading_deg"),
    [
        ((15.0, 0.0), 0.0),  # 正对：框底中点偏差 2.25 m → 0
        ((15.0, 3.0), 90.0),  # 侧对：0.91 → 0.48 m
        ((12.0, -4.0), 30.0),  # 斜看：2.41 → 0.45 m
        ((20.0, 5.0), 135.0),
        ((10.0, 0.0), 45.0),
        ((25.0, -6.0), 0.0),
        ((8.0, 6.0), 60.0),
    ],
)
def test_vehicle_contact_point(center: tuple[float, float], heading_deg: float) -> None:
    """A5：框底边中点映射得近端点，沿视线外移车身投影长度的一半，落在车身中心附近。
    剩余偏差来自框底中点不在车身轮廓的最近角上，斜看与侧对时约 0.2～0.5 m。"""
    mapping = GroundMapping.from_pose(POSE, WIDTH, HEIGHT)
    assert mapping is not None
    x1, _, x2, y2 = car_box(center, heading_deg)
    u = (x1 + x2) / 2
    near = mapping.locate(u, y2, 0)
    outward = mapping.outward(u, y2)
    assert near is not None and outward is not None

    contact = np.array(near[:2]) + vehicle_offset("car", heading_deg, outward)

    before = np.hypot(*(np.array(near[:2]) - center))
    after = np.hypot(*(contact - center))
    assert after <= 0.5
    assert after < before


def test_vehicle_offset_without_heading_uses_mean_size() -> None:
    """静止或尚无朝向：投影长度取长、宽的平均，沿视线外移其一半。"""
    offset = vehicle_offset("car", None, np.array([0.0, 1.0]))

    assert offset == pytest.approx([0, (4.5 + 1.8) / 4])
