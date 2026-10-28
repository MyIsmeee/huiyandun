"""目标朝向与速度：由最近 1 s 的实测平面坐标估计（TK-111）。"""

import pytest

from vision_engine.kinematics import Motion


def feed(motion: Motion, points: list[tuple[float, float]], key: int = 1, dt: float = 0.2):
    result = (None, None)
    for i, (x, y) in enumerate(points):
        result = motion.update(key, i * dt, x, y)
    return result


def test_unknown_before_three_samples() -> None:
    assert feed(Motion(), [(0, 0), (0.2, 0)]) == (None, None)


@pytest.mark.parametrize(
    ("step", "heading"), [((0.2, 0), 0), ((0, 0.2), 90), ((-0.2, 0), 180), ((0, -0.2), 270)]
)
def test_heading_and_speed(step: tuple[float, float], heading: float) -> None:
    """每 0.2 s 移动 0.2 m：速度 1 m/s；朝向 0 为 +x、逆时针为正。"""
    points = [(step[0] * i, step[1] * i) for i in range(4)]

    assert feed(Motion(), points) == pytest.approx((heading, 1.0))


def test_still_target_has_speed_but_no_heading() -> None:
    """静止目标的朝向由脚点抖动决定，不输出。"""
    heading, speed = feed(Motion(), [(0, 0), (0.01, 0), (0, 0.01), (0.01, 0.01)])

    assert heading is None and speed == pytest.approx(0.01414 / 0.6, abs=0.001)


def test_window_uses_last_second_only() -> None:
    """先向 +x 走 2 s，再向 +y 走 1.2 s：朝向只反映最近 1 s。"""
    points = [(0.2 * i, 0.0) for i in range(11)] + [(2.0, 0.2 * i) for i in range(1, 7)]

    heading, _ = feed(Motion(), points)

    assert heading == pytest.approx(90)


def test_targets_tracked_independently() -> None:
    motion = Motion()
    for i in range(4):
        motion.update(1, i * 0.2, 0.2 * i, 0)
        last = motion.update(2, i * 0.2, 0, -0.2 * i)

    assert last == pytest.approx((270, 1.0))
