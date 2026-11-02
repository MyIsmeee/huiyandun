"""画面可信度：冻结逐像素相同满 5 s 报一次、出现不同帧即重新计时（FR-301）；重放（FR-302）。"""

from types import SimpleNamespace
from typing import cast

import numpy as np
import onnxruntime as ort
import pytest

from vision_engine import integrity
from vision_engine.integrity import (
    FREEZE_S,
    REPLAY_CHECKS,
    REPLAY_S,
    SAMPLE_FPS,
    FrameEmbedder,
    FreezeDetector,
    Replay,
    ReplayDetector,
    best_match,
)

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


# 重放判定（FR-302）：以合成嵌入代替模型。场景 = 固定的背景向量 + 缓慢变化的运动成分（每个时刻都不同）
DIM = 384


def scene(seconds: float, seed: int = 0, motion: float = 0.5) -> np.ndarray:
    rng = np.random.default_rng(seed)
    background = rng.normal(size=DIM)
    background /= np.linalg.norm(background)
    z, out = np.zeros(DIM), []
    for _ in range(int(seconds * SAMPLE_FPS)):
        z = 0.9 * z + rng.normal(scale=0.05, size=DIM)  # 相邻采样相似度约 0.97
        e = background + motion * z
        out.append(e / np.linalg.norm(e))
    return np.array(out)


def replays(embeddings: np.ndarray) -> list[tuple[float, Replay]]:
    detector = ReplayDetector()
    return [
        (i / SAMPLE_FPS, found)
        for i, e in enumerate(embeddings)
        if (found := detector.update(e, i / SAMPLE_FPS))
    ]


def replayed(live: np.ndarray, ago_s: float, seconds: float, seed: int = 1) -> np.ndarray:
    """live 之后接上 ago_s 前开始的 seconds 长片段，叠加重新编码的噪声。"""
    start = len(live) - int(ago_s * SAMPLE_FPS)
    clip = live[start : start + int(seconds * SAMPLE_FPS)]
    noisy = clip + np.random.default_rng(seed).normal(scale=0.005, size=clip.shape)
    return np.vstack([live, noisy / np.linalg.norm(noisy, axis=1, keepdims=True)])


def test_live_scene_never_reported_as_replay() -> None:
    assert replays(scene(250)) == []


def test_replayed_clip_reported_once_with_matched_time() -> None:
    found = replays(replayed(scene(120), ago_s=60, seconds=40))

    [(at, replay)] = found  # 持续重放只报一次
    assert replay.ago_s == pytest.approx(60, abs=0.4)
    assert 0.5 <= replay.confidence <= 1
    assert 120 + REPLAY_S <= at <= 120 + REPLAY_S + REPLAY_CHECKS + 1  # 当前段全为重放内容后约 3 s


def test_clip_younger_than_30_s_not_reported() -> None:
    assert replays(replayed(scene(120), ago_s=20, seconds=40)) == []


def test_replayed_static_scene_not_reported() -> None:
    """静止画面去掉均值后只剩噪声（FR-302 的例外，由冻结判定覆盖）。"""
    assert replays(replayed(scene(120, motion=0.0001), ago_s=60, seconds=40)) == []


def test_segment_with_scene_cut_not_judged(monkeypatch: pytest.MonkeyPatch) -> None:
    """当前 10 s 内有画面切换时不比对：切换与历史中别处的切换也相关，会匹配到错误的时刻。"""
    checked: list[int] = []
    monkeypatch.setattr(integrity, "best_match", lambda seq: checked.append(len(seq)) or (0.0, 0))

    replays(np.vstack([scene(40), scene(15, seed=5)]))  # 40 s 处切换到另一场景

    # 满 40 s 后每秒检查一次（第 200～275 个采样）：切换前比对一次，切换移出当前 10 s 后（第 250 个起）再比对
    assert checked == [200, 250, 255, 260, 265, 270, 275]


def frozen(embedding: np.ndarray, seconds: float) -> np.ndarray:
    """冻结：逐帧相同的嵌入。"""
    return np.repeat(embedding[None], int(seconds * SAMPLE_FPS), axis=0)


def test_still_history_scores_zero() -> None:
    """没有变化的历史段去掉均值与趋势后为 0：float32 的舍入残差不得被当作分母放大成高相关。"""
    live = scene(REPLAY_S, seed=4).astype(np.float32)
    history = frozen(live[0], 60)  # 起点距当前段 30 s 以上的历史段全部落在冻结片段内

    assert best_match(np.vstack([history, live])) == (0.0, 0)


def test_replay_detected_after_freeze_in_history() -> None:
    """主剧本顺序：冻结 40 s、恢复，之后重放冻结之前的片段，仍须检出（复核阻断 1）。"""
    live = scene(100).astype(np.float32)
    f = SAMPLE_FPS
    history = np.vstack([live[: 80 * f], frozen(live[80 * f - 1], 40), live[80 * f :]])
    clip = live[40 * f : 70 * f]  # 冻结之前、距今约 100 s 的片段

    [(_, replay)] = replays(np.vstack([history, clip]))

    assert replay.ago_s == pytest.approx(100, abs=0.4)


def test_replay_after_live_gap_reported_again() -> None:
    first = replayed(scene(120), ago_s=60, seconds=30)
    live = np.vstack([first, scene(40, seed=2)])
    found = replays(replayed(live, ago_s=60, seconds=30))

    assert len(found) == 2


class FakeSession:
    def get_inputs(self) -> list[SimpleNamespace]:
        return [SimpleNamespace(name="pixel_values")]

    def run(self, outputs: None, feeds: dict[str, np.ndarray]) -> list[np.ndarray]:
        self.shape = feeds["pixel_values"].shape
        hidden = np.zeros((1, 257, DIM), np.float32)
        hidden[0, 0, :2] = 3, 4  # CLS
        hidden[0, 1:] = 1
        return [hidden]


def test_embedder_returns_unit_cls_of_whole_frame() -> None:
    session = FakeSession()
    embedder = FrameEmbedder(cast(ort.InferenceSession, session))

    embedding = embedder(np.zeros((720, 1280, 3), np.uint8))

    assert session.shape == (1, 3, 224, 224)  # 整帧缩放，不裁剪
    assert embedding[:2] == pytest.approx([0.6, 0.8]) and not embedding[2:].any()
