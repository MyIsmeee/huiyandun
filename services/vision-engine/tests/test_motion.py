"""运动门控：只把运动区域与已有轨迹送推理，无运动且无轨迹时跳过。"""

import numpy as np

from vision_engine.motion import MIN_SIZE, MotionGate

W, H = 1280, 720
NO_BOXES = np.empty((0, 4))


def frame(square: tuple[int, int] | None = None, noise: int = 0) -> np.ndarray:
    image = np.full((H, W, 3), 40, np.uint8)
    if square:
        x, y = square
        image[y : y + 80, x : x + 40] = 230
    if noise:
        image[:2, :2] += noise  # 4 个像素：远低于运动阈值的面积
    return image


def primed() -> MotionGate:
    gate = MotionGate()
    assert gate.region(frame(), NO_BOXES) == (0, 0, W, H)  # 首帧整帧推理
    return gate


def test_static_scene_skips_inference() -> None:
    gate = primed()

    assert gate.region(frame(), NO_BOXES) is None


def test_tiny_change_is_noise() -> None:
    gate = primed()

    assert gate.region(frame(noise=200), NO_BOXES) is None


def test_motion_region_covers_moving_object() -> None:
    gate = primed()

    region = gate.region(frame(square=(1000, 500)), NO_BOXES)

    assert region is not None
    x1, y1, x2, y2 = region
    assert x1 <= 1000 and y1 <= 500 and x2 >= 1040 and y2 >= 580
    assert x2 - x1 == MIN_SIZE and y2 - y1 == MIN_SIZE  # 运动区域小，扩为模型输入大小
    assert 0 <= x1 and x2 <= W and 0 <= y1 and y2 <= H


def test_still_track_keeps_region() -> None:
    # 跌倒后静止的人没有帧差，仍须推理以维持轨迹
    gate = primed()

    region = gate.region(frame(), np.array([[100.0, 50.0, 180.0, 250.0]]))

    assert region is not None
    x1, y1, x2, y2 = region
    assert x1 <= 100 and y1 <= 50 and x2 >= 180 and y2 >= 250
