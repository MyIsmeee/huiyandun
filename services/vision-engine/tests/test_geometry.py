"""地平面单应映射（C-CV-05、C-CV-06）：拟合、重投影误差、未标定判定、脚点定位与误差估计。"""

import math

import numpy as np
import pytest

from vision_engine.geometry import GroundMapping

# demo/scenarios/site.yaml 中 cam-01 的标定点：恰好 4 组，单应矩阵精确拟合
CAM_01 = [[312, 540, 4.0, 6.0], [980, 552, 9.5, 6.2], [450, 300, 5.1, 14.0], [870, 310, 10.2, 13.8]]
# 正视地面：1 像素 = 1 cm
CORNERS = [(100, 100), (500, 100), (100, 500), (500, 500)]
TOP_DOWN = [[u, v, u / 100, v / 100] for u, v in CORNERS]


def fit(calibration: list[list[float]]) -> GroundMapping:
    mapping = GroundMapping.fit(calibration)
    assert mapping is not None
    return mapping


def test_four_points_fit_exactly() -> None:
    mapping = fit(CAM_01)

    assert mapping.reproj_error_m == pytest.approx(0, abs=1e-6)  # 浮点误差，1 µm 以内
    for u, v, x, y in CAM_01:
        located = mapping.locate(u, v, box_h=0)
        assert located is not None
        assert located[:2] == pytest.approx((x, y))


def test_reproj_error_is_rms_in_meters() -> None:
    # 每个像素点给出左右各偏 d 的两组平面坐标：拟合结果居中，每组残差恰为 d
    d = 0.3
    calibration = [[u, v, u / 100 + s, v / 100] for u, v in CORNERS for s in (d, -d)]

    assert fit(calibration).reproj_error_m == pytest.approx(d)


@pytest.mark.parametrize("points", [0, 3])
def test_fewer_than_four_points_is_uncalibrated(points: int) -> None:
    assert GroundMapping.fit(CAM_01[:points]) is None


@pytest.mark.parametrize(
    "pixels",
    [
        [(100, 100), (200, 200), (300, 300), (400, 400)],  # 共线
        [(100, 100), (100, 100), (500, 100), (100, 500)],  # 只有 3 个不同的点
        [(100, 100), (300, 100), (500, 100), (100, 500), (100, 500)],  # 5 组中无 4 点不共线
    ],
)
def test_degenerate_pixels_are_uncalibrated(pixels: list[tuple[int, int]]) -> None:
    calibration = [[u, v, i, i * i] for i, (u, v) in enumerate(pixels)]

    assert GroundMapping.fit(calibration) is None


def test_collinear_plane_points_are_uncalibrated() -> None:
    calibration = [[u, v, i, i] for i, (u, v) in enumerate(CORNERS)]

    assert GroundMapping.fit(calibration) is None


def test_misordered_plane_points_are_uncalibrated() -> None:
    # 两组的平面坐标互换：平面四边形自相交，标定点被映射到地平线两侧
    calibration = [row.copy() for row in TOP_DOWN]
    calibration[2][2:], calibration[3][2:] = calibration[3][2:], calibration[2][2:]

    assert GroundMapping.fit(calibration) is None


def test_uncertainty_is_foot_offset_on_ground() -> None:
    # 人体框高 200 像素 → 脚点上下偏移 10 像素 → 地面上 0.1 m
    located = fit(TOP_DOWN).locate(300, 300, box_h=200)

    assert located == pytest.approx((3.0, 3.0, 0.1))


def test_uncertainty_adds_reproj_error() -> None:
    d = 0.3
    calibration = [[u, v, u / 100 + s, v / 100] for u, v in CORNERS for s in (d, -d)]

    located = fit(calibration).locate(300, 300, box_h=200)

    assert located is not None
    assert located[2] == pytest.approx(d + 0.1)


def test_uncertainty_grows_with_distance() -> None:
    mapping = fit(CAM_01)
    near = mapping.locate(640, 550, box_h=200)
    far = mapping.locate(640, 300, box_h=200)

    assert near is not None
    assert far is not None
    assert far[2] > near[2] > 0


# 仰视角度较大的摄像头：地平线在画面内 v = 200 处，以上为天空。由平面 → 像素的逆映射生成标定点
def horizon_calibration() -> list[list[float]]:
    def plane(u: float, v: float) -> tuple[float, float]:
        w = 0.005 * v - 1
        return 0.01 * u / w, 0.01 * v / w

    return [[u, v, *plane(u, v)] for u, v in [(100, 300), (900, 300), (100, 700), (900, 700)]]


def test_locates_below_horizon() -> None:
    located = fit(horizon_calibration()).locate(500, 500, box_h=100)

    assert located is not None
    assert all(math.isfinite(value) for value in located)


@pytest.mark.parametrize(
    ("v", "box_h"),
    [
        (150, 0),  # 脚点在地平线以上
        (205, 200),  # 脚点在地平线以下，上偏 10 像素越过地平线
    ],
)
def test_no_location_above_horizon(v: float, box_h: float) -> None:
    assert fit(horizon_calibration()).locate(500, v, box_h=box_h) is None


POSE = {
    "x": 0.0,
    "y": 0.0,
    "height_m": 3.0,
    "yaw_deg": 0.0,
    "pitch_deg": -45.0,
    "hfov_deg": 90.0,
    "range_m": 15,
}


def test_from_pose_center_pixel_lands_where_optical_axis_meets_ground() -> None:
    """俯角 45°、高 3 m：画面中心的视线落在正前方 3 m 处（D-102）。"""
    mapping = GroundMapping.from_pose(POSE, 1280, 720)
    assert mapping is not None
    x, y, _ = mapping.locate(640, 360, 0)
    assert (x, y) == pytest.approx((3.0, 0.0), abs=1e-6)


def test_from_pose_follows_yaw_and_left_right() -> None:
    """朝向 90° 时正前方为平面 +y；画面右侧在朝向的右手边（+x）。"""
    mapping = GroundMapping.from_pose(POSE | {"yaw_deg": 90.0}, 1280, 720)
    assert mapping is not None
    x, y, _ = mapping.locate(640, 360, 0)
    assert (x, y) == pytest.approx((0.0, 3.0), abs=1e-6)
    right, _, _ = mapping.locate(1000, 600, 0)
    assert right > 0


def test_from_pose_error_grows_with_distance() -> None:
    mapping = GroundMapping.from_pose(POSE, 1280, 720)
    assert mapping is not None
    _, _, near = mapping.locate(640, 700, 0)
    _, _, far = mapping.locate(640, 360, 0)
    assert near < far
    assert far == pytest.approx(0.1 * 3.0)


def test_from_pose_looking_at_horizon_is_unmapped() -> None:
    assert GroundMapping.from_pose(POSE | {"pitch_deg": 60.0}, 1280, 720) is None


# 安装高度 3 m、俯角 10° 的 1920×1080 画面：地平线约在 v = 375，标定点取在其下
TILTED = GroundMapping.from_pose(
    {"x": 0, "y": 0, "height_m": 3, "yaw_deg": 90, "pitch_deg": -10, "hfov_deg": 90, "range_m": 30},
    1920,
    1080,
)


def tilted(pixels: list[tuple[float, float]]) -> list[list[float]]:
    """由已知单应生成标定点 [u, v, x, y]。"""
    assert TILTED is not None
    ground = TILTED.to_plane(np.array(pixels, dtype=np.float64))
    return [[u, v, float(x), float(y)] for (u, v), (x, y) in zip(pixels, ground, strict=True)]


def test_calibrate_exact() -> None:
    """A1：4 组点由已知单应生成，拟合后各组偏差为 0。"""
    points = tilted([(300, 600), (1600, 620), (400, 1000), (1500, 950)])

    result = GroundMapping.calibrate(points)

    assert not isinstance(result, str)
    mapping, residuals = result
    assert residuals == pytest.approx([0] * 4, abs=1e-6)
    assert mapping.reproj_error_m == pytest.approx(0, abs=1e-6)


def test_calibrate_residuals_match_points() -> None:
    d = 0.3
    calibration = [[u, v, u / 100 + s, v / 100] for u, v in CORNERS for s in (d, -d)]

    result = GroundMapping.calibrate(calibration)

    assert not isinstance(result, str)
    assert result[1] == pytest.approx([d] * 8)


def test_calibrate_collinear() -> None:
    """A2：画面点或地面点找不到 4 个任意三点不共线的点时，分别指出。"""
    line = [(100, 100), (200, 200), (300, 300), (400, 400)]
    pixels_collinear = [[u, v, i, i * i] for i, (u, v) in enumerate(line)]
    # 画面点为正方形四角；地面点有 3 个在 y = 0 上
    ground_collinear = [[u, v, i, 0 if i < 3 else 1] for i, (u, v) in enumerate(CORNERS)]

    assert GroundMapping.calibrate(pixels_collinear) == "pixels_collinear"
    assert GroundMapping.calibrate(ground_collinear) == "ground_collinear"


def test_calibrate_inconsistent() -> None:
    """A3：一组画面点移到地平线以上，拟合后标定点分处地平线两侧。"""
    points = tilted([(300, 600), (1600, 620), (900, 800), (400, 1000), (1500, 950)])
    points[2][1] = 150

    assert GroundMapping.calibrate(points) == "inconsistent"
    assert GroundMapping.fit(points) is None
