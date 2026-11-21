"""单目几何自动标定（monocular.py）：以合成房间的点云验证焦距与偏移恢复、地面拟合与桌面尺度校正。"""

import math

import numpy as np
import pytest

from vision_engine.monocular import (
    RUNS,
    Geometry,
    combine,
    floor_geometry,
    focal_of,
    point_cloud,
    recover_focal_shift,
    view_plane_uv,
)

W, H = 320, 180


def room(height: float, pitch: float, hfov: float, desk: bool = True):
    """相机系（x 右、y 下、z 前）下的点云与法向：地面 y=0、后墙在前方 7 m、桌面（0.75 m）铺在近处。"""
    fx = 0.5 / math.tan(math.radians(hfov) / 2) * W
    xs = (np.arange(W) + 0.5) - W / 2
    ys = (np.arange(H) + 0.5) - H / 2
    rays = np.stack(np.broadcast_arrays(xs[None, :] / fx, ys[:, None] / fx, np.ones((H, W))), -1)
    p = math.radians(pitch)
    # 相机系 → 世界系（x 右、y 上、z 前）：先翻转 y，再绕 x 轴转俯角
    to_world = np.array([[1, 0, 0], [0, math.cos(p), math.sin(p)], [0, -math.sin(p), math.cos(p)]])
    to_world = to_world @ np.diag([1, -1, 1])
    world = rays @ to_world.T
    origin = np.array([0.0, height, 0.0])
    t = np.full((H, W), np.inf)
    normal_w = np.zeros((H, W, 3))
    planes = [((0, 1, 0), 0.0, None)]  # 地面
    if desk:
        planes.append(((0, 1, 0), 0.75, (-1.5, 1.5, 1.5, 3.5)))  # 桌面：x、z 范围
    for n, level, box in planes:
        dy = world[..., 1]
        with np.errstate(divide="ignore", invalid="ignore"):
            hit = (level - origin[1]) / dy
        at = origin + hit[..., None] * world
        ok = (hit > 0) & (hit < t)
        if box is not None:
            ok &= (
                (at[..., 0] > box[0])
                & (at[..., 0] < box[1])
                & (at[..., 2] > box[2])
                & (at[..., 2] < box[3])
            )
        t = np.where(ok, hit, t)
        normal_w[ok] = n
    with np.errstate(divide="ignore"):
        wall = (7.0 - origin[2]) / world[..., 2]
    ok = (wall > 0) & (wall < t)
    t = np.where(ok, wall, t)
    normal_w[ok] = (0, 0, -1)
    from_world = np.linalg.inv(to_world)
    cloud = (t[..., None] * rays).astype(np.float64)
    normals = normal_w @ from_world.T
    return cloud, normals, np.isfinite(t)


@pytest.mark.parametrize(("height", "pitch", "hfov"), [(2.0, -15.0, 75.0), (3.2, -35.0, 95.0)])
def test_floor_recovers_height_pitch_and_desk_keeps_scale(
    height: float, pitch: float, hfov: float
) -> None:
    cloud, normals, valid = room(height, pitch, hfov)
    g = floor_geometry(cloud, normals, valid, hfov)
    assert g is not None
    assert g.height_m == pytest.approx(height, abs=0.05)
    assert g.pitch_deg == pytest.approx(pitch, abs=0.5)
    assert abs(g.roll_deg) < 0.5 and g.hfov_deg == hfov
    assert g.scale_ref == "desk"  # 桌面 0.75 m：校正倍数为 1


def test_desk_corrects_wrong_metric_scale() -> None:
    """模型尺度偏大 30%：桌面按 0.75 m 校正，高度回到真值；俯角与尺度无关。"""
    cloud, normals, valid = room(2.0, -15.0, 75.0)
    g = floor_geometry(cloud * 1.3, normals, valid, 75.0)
    assert g is not None and g.scale_ref == "desk"
    assert g.height_m == pytest.approx(2.0, abs=0.05) and g.pitch_deg == pytest.approx(
        -15.0, abs=0.5
    )


def test_without_desk_keeps_model_scale() -> None:
    cloud, normals, valid = room(2.0, -15.0, 75.0, desk=False)
    g = floor_geometry(cloud * 1.3, normals, valid, 75.0)
    assert g is not None and g.scale_ref == "model"
    assert g.height_m == pytest.approx(2.6, abs=0.05)


def test_no_visible_floor_gives_no_suggestion() -> None:
    """抬头看墙：看不到地面，不给建议。"""
    cloud, normals, valid = room(2.0, 5.0, 40.0, desk=False)
    assert floor_geometry(cloud, normals, valid, 40.0) is None


def test_focal_and_shift_recovered_from_affine_point_map() -> None:
    """模型输出的是仿射不变点图（缩放、深度平移未知）：恢复的焦距给出视角，偏移还原深度。"""
    cloud, normals, valid = room(2.0, -15.0, 75.0)
    cloud[~valid] = 0
    raw = cloud / 4.0 - np.array([0, 0, 0.3])  # 缩放 1/4、深度平移 −0.3
    focal, shift = recover_focal_shift(raw, valid)
    assert shift == pytest.approx(0.3, abs=0.01)
    built = point_cloud(raw, valid, 4.0)
    assert built is not None
    rebuilt, ok, hfov = built
    assert hfov == pytest.approx(75.0, abs=0.5)
    assert np.allclose(rebuilt[ok & valid], cloud[ok & valid], atol=0.05)
    assert view_plane_uv(W, H).shape == (H, W, 2)


def test_known_view_angle_fixes_focal_and_only_shift_is_solved() -> None:
    """视角已知（安装参数）时焦距固定为它，只求深度偏移；结果与自估一致，视角原样返回。"""
    cloud, _, valid = room(2.0, -15.0, 75.0)
    cloud[~valid] = 0
    raw = cloud / 4.0 - np.array([0, 0, 0.3])
    focal = focal_of(75.0, W, H)
    estimated, _ = recover_focal_shift(raw, valid) or (math.nan, math.nan)
    assert focal == pytest.approx(estimated, rel=0.01)
    found, shift = recover_focal_shift(raw, valid, focal) or (math.nan, math.nan)
    assert found == focal and shift == pytest.approx(0.3, abs=0.01)
    built = point_cloud(raw, valid, 4.0, focal_of(70.0, W, H))
    assert built is not None and built[2] == pytest.approx(70.0, abs=0.01)


def test_combine_takes_median_and_needs_half_of_runs() -> None:
    def g(h: float, ref: str = "desk") -> Geometry:
        return Geometry(h, -10.0, 0.0, 74.0, 4.0, 3.0, 5000, ref)

    out = combine([g(1.5), g(1.8), g(2.0, "model")])
    assert out is not None and out.height_m == 1.8 and out.scale_ref == "desk"
    assert combine([g(1.8)] * (len(RUNS) // 2 - 1)) is None
