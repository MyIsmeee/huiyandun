"""三维场景初稿（scene3d.py）：以合成房间的点云与分割，验证家具按实测尺寸、墙按实测位置给出。"""

import numpy as np
import pytest
from test_monocular import room

from vision_engine.geometry import GroundMapping
from vision_engine.monocular import Reconstruction, floor_plane
from vision_engine.pipeline import _box_mask
from vision_engine.scene import label
from vision_engine.scene3d import _dominant, _merge, _snap, align, layout

POSE = {"x": 0.0, "y": 0.0, "yaw_deg": 0.0, "range_m": 15.0, "height_m": 9.0, "pitch_deg": -60.0}


def build(height: float = 2.0, pitch: float = -25.0, wall_up_to: float = 9.0):
    """合成房间的重建与分割；wall_up_to 以上的墙面不标为墙（模拟墙被遮挡、只看得到墙脚一条）。"""
    cloud, normals, valid = room(height, pitch, 90.0)
    floor = floor_plane(cloud, normals, valid)
    assert floor is not None
    up = floor.up
    h = cloud @ up + floor.d
    labels = np.zeros(valid.shape, np.uint8)
    labels[valid & (np.abs(h) < 0.02)] = label("floor")
    labels[valid & (np.abs(h - 0.75) < 0.02)] = label("table")
    labels[valid & (np.abs(normals @ up) < 0.1) & (h < wall_up_to)] = label("wall")
    return labels, Reconstruction(cloud, normals, valid, floor)


def scene(height: float = 2.0, pitch: float = -25.0, pose: dict = POSE) -> dict:
    labels, rec = build(height, pitch)
    return layout(labels, rec, pose)


def table_center(out: dict) -> np.ndarray:
    (table,) = [o for o in out["objects"] if o["class"] == "table"]
    return np.array(table["polygon"]).mean(axis=0)


TRUE_POSE = POSE | {"height_m": 2.0, "pitch_deg": -25.0, "hfov_deg": 90.0}


def test_table_measured_from_points_not_default_size() -> None:
    """桌面在相机前 1.5～3.5 m、左右各 1.5 m、高 0.75 m：平面坐标中心 (2.5, 0)、2 × 3 m。
    安装参数故意填错（9 m、−60°）：点云自带几何，不受影响。"""
    out = scene()
    (table,) = [o for o in out["objects"] if o["class"] == "table"]
    polygon = np.array(table["polygon"])
    assert polygon.mean(axis=0) == pytest.approx([2.5, 0.0], abs=0.25)
    sides = sorted(np.linalg.norm(np.diff(np.vstack([polygon, polygon[:1]]), axis=0), axis=1)[:2])
    assert sides == pytest.approx([2.0, 3.0], abs=0.4)
    assert table["height_m"] == pytest.approx(0.75, abs=0.1)


def test_back_wall_at_measured_distance_and_floor_present() -> None:
    out = scene()
    (wall,) = out["walls"]
    line = np.array(wall["line"])
    assert line[:, 0] == pytest.approx([7.0, 7.0], abs=0.2)  # 后墙在前方 7 m
    assert wall["height_m"] >= 2.8
    assert [s["class"] for s in out["surfaces"]] == ["floor"]


def test_pose_position_and_yaw_place_the_room() -> None:
    """只用登记的平面位置与朝向：朝 +y（90°）、位于 (10, 5) 时，桌子在 (10, 7.5)。"""
    out = scene(pose=POSE | {"x": 10.0, "y": 5.0, "yaw_deg": 90.0})
    (table,) = [o for o in out["objects"] if o["class"] == "table"]
    assert np.array(table["polygon"]).mean(axis=0) == pytest.approx([10.0, 7.5], abs=0.25)


def test_walls_snap_to_dominant_direction_and_merge() -> None:
    """同一面墙被拟合成两条略斜、相隔 0.3 m 的线：贴齐主方向后合并为一条，跨度取两者之和。"""
    a = np.array([[0.0, 0.0], [4.0, 0.2]])
    b = np.array([[3.0, 0.3], [8.0, 0.1]])
    side = np.array([[0.0, 0.0], [0.1, 5.0]])
    dominant = _dominant([a, b, side])
    assert dominant is not None and abs(_snap(3.0, dominant)) < 1.0
    merged = _merge([("wall", a, 2.8), ("wall", b, 3.0), ("wall", side, 2.8)], dominant)
    assert len(merged) == 2
    long = max(merged, key=lambda m: np.linalg.norm(m[1][1] - m[1][0]))
    assert np.linalg.norm(long[1][1] - long[1][0]) == pytest.approx(8.0, abs=0.3)
    assert long[2] == 3.0


def test_align_rescales_cloud_to_people_mapping() -> None:
    """模型尺度偏小 20%：按人员所用的地面映射（安装参数正确）整体放大，桌子回到 (2.5, 0)、后墙回到 7 m。"""
    labels, rec = build()
    small = rec.scaled(0.8, "model")
    assert table_center(layout(labels, small, POSE))[0] == pytest.approx(2.0, abs=0.25)
    mapping = GroundMapping.from_pose(TRUE_POSE, 320, 180)
    fixed, pose, factor = align(small, mapping, POSE, (320, 180))
    assert factor == pytest.approx(1.25, abs=0.03)
    assert fixed.floor.scale_ref == "mapping" and fixed.floor.d == pytest.approx(2.0, abs=0.05)
    out = layout(labels, fixed, pose)
    assert table_center(out) == pytest.approx([2.5, 0.0], abs=0.25)
    (wall,) = out["walls"]
    assert np.array(wall["line"])[:, 0] == pytest.approx([7.0, 7.0], abs=0.25)


def test_align_corrects_small_yaw_error_and_skips_absurd_mapping() -> None:
    """登记朝向偏了 10°：按地面映射转回；映射与点云差出数倍（多半映射本身不成立）时不对齐。"""
    labels, rec = build()
    mapping = GroundMapping.from_pose(TRUE_POSE, 320, 180)
    _, pose, _ = align(rec, mapping, POSE | {"yaw_deg": 10.0}, (320, 180))
    assert pose["yaw_deg"] == pytest.approx(0.0, abs=1.0)
    far = GroundMapping.from_pose(TRUE_POSE | {"height_m": 8.0}, 320, 180)
    same, kept, factor = align(rec, far, POSE, (320, 180))
    assert factor is None and same is rec and kept is POSE
    assert align(rec, None, POSE, (320, 180))[2] is None


def test_wall_base_from_floor_boundary_when_wall_mostly_hidden() -> None:
    """墙只看得到离地 0.15 m 以下的一条（上方被柜子、隔板挡住）：墙面点不够，按其下方的地面像素仍量出墙脚在 7 m。"""
    labels, rec = build(wall_up_to=0.15)
    (wall,) = layout(labels, rec, POSE)["walls"]
    assert np.array(wall["line"])[:, 0] == pytest.approx([7.0, 7.0], abs=0.2)
    assert wall["height_m"] == pytest.approx(2.8)  # 看不到上沿：类别默认值


def test_box_mask_expands_boxes_and_clips_to_frame() -> None:
    assert _box_mask((100, 200), np.empty((0, 4))) is None
    mask = _box_mask((100, 200), np.array([[10.0, 20.0, 30.0, 60.0], [190.0, 90.0, 210.0, 120.0]]))
    assert mask is not None and mask.shape == (100, 200)
    assert mask[16, 8] and mask[63, 31] and not mask[10, 40]  # 外扩 10%：宽 20 → 2 px、高 40 → 4 px
    assert mask[99, 199]


def test_object_kind_is_majority_ade20k_class_within_cluster() -> None:
    """桌面像素多数为 desk（33）、少数为 table（15）：物体带细分类别 desk；不给原始类别时不带 kind。"""
    labels, rec = build()
    ade = np.zeros(labels.shape, np.uint8)
    table = labels == label("table")
    ade[table] = 33
    rows = np.argwhere(table)
    ade[tuple(rows[: len(rows) // 4].T)] = 15
    (with_kind,) = [o for o in layout(labels, rec, POSE, ade)["objects"] if o["class"] == "table"]
    (without,) = [o for o in layout(labels, rec, POSE)["objects"] if o["class"] == "table"]
    assert with_kind["kind"] == "desk"
    assert "kind" not in without


def test_small_items_on_table_carry_base_height() -> None:
    """桌面上的显示器：归为电器（appliance）、细分类别为 monitor，带底部离地高度；桌子本身不带（会悬空）。"""
    labels, rec = build()
    h = rec.cloud @ rec.floor.up + rec.floor.d
    top = rec.valid & (np.abs(h - 0.75) < 0.02)
    cols = np.where(top.any(axis=0))[0]
    screen = top.copy()
    screen[:, cols[len(cols) // 2] :] = False  # 桌面左半边当作显示器
    labels[screen] = label("appliance")
    ade = np.zeros(labels.shape, np.uint8)
    ade[screen] = 143  # ADE20K monitor

    out = layout(labels, rec, POSE, ade)

    (item,) = [o for o in out["objects"] if o["class"] == "appliance"]
    assert item["kind"] == "monitor"
    assert 0.6 <= item["base_m"] <= 0.75
    assert all("base_m" not in o for o in out["objects"] if o["class"] == "table")


def test_small_items_not_eroded_away() -> None:
    """一台远处的显示器只占分割的几格，腐蚀后约百来个点：小件点数下限低，仍给出；同样大小的柜子按噪声丢弃。"""
    labels, rec = build()
    h = rec.cloud @ rec.floor.up + rec.floor.d
    top = rec.valid & (np.abs(h - 0.75) < 0.02)
    r, c = np.argwhere(top)[len(np.argwhere(top)) // 2]
    patch = np.zeros_like(top)
    patch[r - 5 : r + 5, c - 12 : c + 12] = True  # 腐蚀 2 像素后剩 6 × 20 = 120 个点
    patch &= top
    assert patch.sum() == 240

    for name, found in (("appliance", True), ("cabinet", False)):
        marked = labels.copy()
        marked[patch] = label(name)
        out = layout(marked, rec, POSE)
        assert any(o["class"] == name for o in out["objects"]) is found, name
