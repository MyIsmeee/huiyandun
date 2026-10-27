"""地平面单应映射（C-CV-05、C-CV-06）：拟合、重投影误差、未标定判定、脚点定位与误差估计。"""

import math

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
