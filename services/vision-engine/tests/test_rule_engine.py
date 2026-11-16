"""轨迹规则（区域入侵、有向越线）：以合成地面轨迹验证滞回、去抖、遮挡、编号错配与方向。"""

import math
import random

import pytest

from vision_engine.rules import (
    COOLDOWN_S,
    LOST_S,
    UPDATE_S,
    Observation,
    RuleEngine,
    RuleEvent,
    line_side,
    polygon_signed_distance,
)

FPS = 5
# 竖直的线 x = 0，自 (0, −5) 指向 (0, 5)：沿线前进方向的左侧为 x < 0，forward 即自西（x<0）向东（x>0）穿过
LINE = {"id": "gate", "name": "大门", "type": "line_crossing", "points": [[0, -5], [0, 5]]}
# 区域 x ∈ [0, 10]、y ∈ [0, 10]
ZONE = {
    "id": "yard",
    "name": "库区",
    "type": "intrusion",
    "points": [[0, 0], [10, 0], [10, 10], [0, 10]],
    "min_duration_s": 1.0,
}


def walk(
    start: tuple[float, float],
    end: tuple[float, float],
    seconds: float,
    t0: float = 0.0,
    jitter: float = 0.0,
    seed: int = 0,
) -> list[tuple[float, float, float]]:
    """匀速走过，每帧 (t, x, y)；jitter 为位置噪声的标准差（米）。"""
    rng = random.Random(seed)
    n = round(seconds * FPS)
    return [
        (
            t0 + i / FPS,
            start[0] + (end[0] - start[0]) * i / max(n - 1, 1) + rng.gauss(0, jitter),
            start[1] + (end[1] - start[1]) * i / max(n - 1, 1) + rng.gauss(0, jitter),
        )
        for i in range(n)
    ]


def run(
    rules: list[dict],
    frames: list[tuple[float, float, float]],
    track: int = 1,
    cls: str = "person",
    sigma: float = 0.2,
    until: float | None = None,
) -> list[RuleEvent]:
    engine = RuleEngine(rules)
    found = []
    for t, x, y in frames:
        found += engine.update([Observation(track, cls, x, y, sigma)], t)
    if until is not None:  # 之后没有观测，只推进时间
        t = frames[-1][0] if frames else 0.0
        while t < until:
            t += 1 / FPS
            found += engine.update([], t)
    return found


def crossings(events: list[RuleEvent]) -> list[tuple[str | None, bool]]:
    return [(e.direction, e.inferred) for e in events if e.rule_type == "line_crossing"]


def test_geometry() -> None:
    square = [(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)]
    assert polygon_signed_distance(square, 5, 5) == pytest.approx(5)
    assert polygon_signed_distance(square, -2, 5) == pytest.approx(-2)
    line = [(0.0, -5.0), (0.0, 5.0)]
    assert line_side(line, -1, 0) == pytest.approx(1)  # 左侧为正
    assert line_side(line, 2, 0) == pytest.approx(-2)
    assert line_side(line, 1, 7) is None  # 绕过线端（外延 0.5 m 之外）


def test_crossing_with_jitter_counted_once_with_direction() -> None:
    events = run([LINE], walk((-4, 0), (4, 0), 6, jitter=0.2))

    assert crossings(events) == [("forward", False)]


def test_round_trip_counts_both_directions() -> None:
    frames = walk((-4, 0), (4, 0), 6) + walk((4, 0), (-4, 0), 6, t0=6 + COOLDOWN_S)

    assert crossings(run([LINE], frames)) == [("forward", False), ("backward", False)]


def test_direction_filter() -> None:
    frames = walk((-4, 0), (4, 0), 6) + walk((4, 0), (-4, 0), 6, t0=8)

    assert crossings(run([LINE | {"direction": "backward"}], frames)) == [("backward", False)]


@pytest.mark.parametrize("seed", range(40))
def test_standing_on_line_is_not_crossing(seed: int) -> None:
    """在线上站 60 s，脚点噪声 0.2 m：始终在滞回带内或回到原侧，不计数。"""
    frames = walk((-1, 0), (0, 0), 2) + walk((0, 0), (0, 0), 60, t0=2, jitter=0.2, seed=seed)

    assert crossings(run([LINE], frames)) == []


def test_walking_along_line_is_not_crossing() -> None:
    assert crossings(run([LINE], walk((-0.1, -4), (0.1, 4), 8, jitter=0.1))) == []


def test_passing_beyond_line_end_is_not_crossing() -> None:
    assert crossings(run([LINE], walk((-4, 7), (4, 7), 6))) == []


def test_crossing_during_occlusion_is_inferred() -> None:
    """越线时被遮挡 2 s：重现后在另一侧，仍计一次并标为推断。"""
    frames = [f for f in walk((-4, 0), (4, 0), 6) if not 2.0 <= f[0] < 4.0]

    assert crossings(run([LINE], frames)) == [("forward", True)]


def test_teleport_after_gap_is_id_mismatch() -> None:
    """消失 1.5 s 后在 20 m 外的另一侧出现：超出步行最大速度，多为编号错配，不计。"""
    frames = walk((-2, 0), (-1, 0), 2) + walk((19, 0), (20, 0), 2, t0=3.5)

    assert crossings(run([LINE], frames)) == []


def test_fast_run_across_band_in_one_frame() -> None:
    """奔跑 6 m/s：一帧跨过滞回带，仍计一次、不算推断。"""
    assert crossings(run([LINE], walk((-6, 0), (6, 0), 2))) == [("forward", False)]


def test_cooldown_suppresses_jitter_recount() -> None:
    """越线后 1 s 内被推回原侧又过来：同方向冷却期内不重复计。"""
    frames = (
        walk((-4, 0), (2, 0), 3)
        + walk((-2, 0), (2, 0), 0.6, t0=3)
        + walk((2, 0), (4, 0), 1, t0=3.6)
    )

    assert [d for d, _ in crossings(run([LINE], frames))].count("forward") == 1


def test_class_filter() -> None:
    assert crossings(run([LINE], walk((-4, 0), (4, 0), 6), cls="car")) == []
    events = run([LINE | {"classes": ["car"]}], walk((-4, 0), (4, 0), 6), cls="car")
    assert crossings(events) == [("forward", False)]


def phases(events: list[RuleEvent]) -> list[tuple[str, str | None]]:
    return [(e.phase, e.end_reason) for e in events if e.rule_type == "intrusion"]


def test_intrusion_start_update_end() -> None:
    frames = (
        walk((-3, 5), (3, 5), 3)
        + walk((3, 5), (3, 5), UPDATE_S + 5, t0=3)
        + walk((3, 5), (-3, 5), 3, t0=3 + UPDATE_S + 5)
    )
    events = run([ZONE], frames)

    assert phases(events) == [("start", None), ("update", None), ("end", "exit")]
    start = events[0]
    assert len({e.episode_id for e in events}) == 1
    assert start.since <= start.track_id + 3  # 起始时刻为确认进入时刻，早于告警时刻
    assert start.since < events[1].since + 1e-9


def test_brief_entry_shorter_than_min_duration_is_not_intrusion() -> None:
    """擦边进入 0.6 s 即离开：不足最短时长，不告警。"""
    frames = walk((-2, 5), (1.5, 5), 1.4) + walk((1.5, 5), (-3, 5), 2, t0=1.4)

    assert phases(run([ZONE], frames)) == []


@pytest.mark.parametrize("seed", range(40))
def test_standing_on_boundary_is_not_intrusion(seed: int) -> None:
    frames = walk((0, 5), (0, 5), 60, jitter=0.2, seed=seed)

    assert phases(run([ZONE], frames)) == []


def test_lost_track_ends_episode() -> None:
    frames = walk((-3, 5), (3, 5), 3) + walk((3, 5), (3, 5), 3, t0=3)
    events = run([ZONE], frames, until=frames[-1][0] + LOST_S + 1)

    assert phases(events) == [("start", None), ("end", "lost")]


def test_far_target_needs_wider_band() -> None:
    """远处目标 σ = 1 m：滞回带 1.5 m，离边界 1 m 的位置不算确定在内。"""
    frames = walk((1, 5), (1, 5), 10)

    assert phases(run([ZONE], frames, sigma=1.0)) == []
    assert phases(run([ZONE], frames, sigma=0.1)) == [("start", None)]


def test_each_entry_alarms_once_per_track_and_tracks_independent() -> None:
    engine = RuleEngine([ZONE])
    found: list[RuleEvent] = []
    for t, x, y in walk((-3, 5), (3, 5), 4):
        found += engine.update(
            [Observation(1, "person", x, y, 0.2), Observation(2, "person", x, y + 1, 0.2)], t
        )

    assert sorted(e.track_id for e in found if e.phase == "start") == [1, 2]
    assert math.isclose(found[0].since, found[1].since)
