"""画面冻结判定（FR-301）：逐像素相同满 5 s 报一次，出现不同帧即重新计时。"""

import numpy as np

from vision_engine.integrity import FREEZE_S, FreezeDetector

FPS = 4  # 时刻取 1/4 s 的倍数，浮点运算无误差


def still(value: int = 100) -> np.ndarray:
    return np.full((72, 128, 3), value, np.uint8)


def feed(detector: FreezeDetector, frames: list[np.ndarray], start: float = 0.0) -> list[float]:
    """按 FPS 送入各帧，返回判定为冻结的时刻。"""
    return [start + i / FPS for i, f in enumerate(frames) if detector.update(f, start + i / FPS)]


def test_identical_frames_for_5_s_report_once() -> None:
    detector = FreezeDetector()

    found = feed(detector, [still()] * (FPS * 20))

    assert found == [FREEZE_S]  # 持续冻结不重复报


def test_shorter_than_5_s_not_reported() -> None:
    detector = FreezeDetector()

    assert feed(detector, [still()] * int(FPS * FREEZE_S)) == []  # 最后一帧距第一帧 4.75 s


def test_one_differing_pixel_restarts_timing() -> None:
    detector = FreezeDetector()
    noisy = still()
    noisy[0, 0, 0] += 1

    found = feed(detector, [still()] * (FPS * 4) + [noisy] + [still()] * (FPS * 6))

    assert found == [4.25 + FREEZE_S]  # 从变化后的第一帧（4.25 s）重新计时


def test_new_freeze_after_change_reported_again() -> None:
    detector = FreezeDetector()

    found = feed(detector, [still(1)] * (FPS * 6) + [still(2)] * (FPS * 6))

    assert found == [FREEZE_S, 6 + FREEZE_S]
