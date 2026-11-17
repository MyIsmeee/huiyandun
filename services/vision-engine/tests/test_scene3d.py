"""三维场景初稿（scene3d.py）：以合成房间的点云与分割，验证家具按实测尺寸、墙按实测位置给出。"""

import numpy as np
import pytest
from test_monocular import room

from vision_engine.monocular import Reconstruction, floor_plane
from vision_engine.scene import label
from vision_engine.scene3d import _dominant, _merge, _snap, layout

POSE = {"x": 0.0, "y": 0.0, "yaw_deg": 0.0, "range_m": 15.0, "height_m": 9.0, "pitch_deg": -60.0}


def scene(height: float = 2.0, pitch: float = -25.0, pose: dict = POSE) -> dict:
    cloud, normals, valid = room(height, pitch, 90.0)
    floor = floor_plane(cloud, normals, valid)
    assert floor is not None
    up = floor.up
    h = cloud @ up + floor.d
    labels = np.zeros(valid.shape, np.uint8)
    labels[valid & (np.abs(h) < 0.02)] = label("floor")
    labels[valid & (np.abs(h - 0.75) < 0.02)] = label("table")
    labels[valid & (np.abs(normals @ up) < 0.1)] = label("wall")
    rec = Reconstruction(cloud, normals, valid, floor)
    return layout(labels, rec, pose)


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
