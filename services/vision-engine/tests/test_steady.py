"""静止人员的位置锁定：画面中头肩不动时，脚点取法来回切换造成的地面位置跳动被压住；走开即跟随。"""

import numpy as np
import pytest

from vision_engine.steady import Steady

BOX = (100.0, 100.0, 200.0, 400.0)


def person(dx: float = 0.0) -> tuple[np.ndarray, np.ndarray]:
    points = np.zeros((17, 2))
    points[:7] = [150 + dx, 130]
    points[5], points[6] = [130 + dx, 160], [170 + dx, 160]
    scores = np.zeros(17)
    scores[:7] = 0.9
    return points, scores


def test_seated_person_stays_put_while_foot_estimate_jumps() -> None:
    steady, out = Steady(), []
    for i in range(30):
        located = (
            (3.0, 2.0, 0.5) if i % 3 else (4.2, 2.6, 0.8)
        )  # 脚踝时隐时现：每 3 帧跳到 1.3 m 外
        out.append(steady.update(7, BOX, *person(dx=(i % 2) * 2), located, i * 0.2))
    tail = np.array(out[10:])  # 窗口攒满（约 1.2 s）后锁定
    assert np.ptp(tail[:, 0]) == pytest.approx(0, abs=1e-9) and tail[-1][0] == 3.0
    assert tail[-1][1] == 2.0


def test_walking_away_releases_the_lock() -> None:
    steady = Steady()
    for i in range(10):
        steady.update(7, BOX, *person(), (3.0, 2.0, 0.5), i * 0.2)
    moved = steady.update(7, BOX, *person(dx=60), (5.0, 2.0, 0.5), 2.2)
    assert moved == (5.0, 2.0, 0.5)


def test_slow_walker_is_not_locked() -> None:
    """慢慢走动（头肩每帧移 4 像素，约 0.8 m/s 的画面速度）：窗口内超出范围，按实测跟随。"""
    steady = Steady()
    out = [
        steady.update(7, BOX, *person(dx=4 * i), (3.0 + 0.1 * i, 2.0, 0.5), i * 0.2)
        for i in range(20)
    ]
    assert out[-1] == (4.9, 2.0, 0.5)


def test_tracks_are_independent() -> None:
    steady = Steady()
    steady.update(1, BOX, *person(), (3.0, 2.0, 0.5), 0.0)
    assert steady.update(2, BOX, *person(), (6.0, 1.0, 0.5), 0.0) == (6.0, 1.0, 0.5)
