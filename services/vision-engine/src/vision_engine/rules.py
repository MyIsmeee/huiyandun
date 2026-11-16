"""轨迹规则（区域入侵、有向越线）：按续接后的输出编号，在地面平面（米）上逐帧判定。

判定点为目标的地面位置（人员为脚点，车辆为接地点，FR-911），位置误差为 uncertainty_m（σ）。
位置先按轨迹取最近 SMOOTH_N 帧的均值（压低逐帧噪声），再以到边界的有符号距离 d 与滞回带
h = max(H_MIN_M, H_SIGMA·σ) 比较，分三态：确定在内 / 确定在外 / 不确定；不确定时保持上一状态，
站在边界上的人不会来回翻转（5 FPS 下每帧步行约 0.3 m，与脚点噪声同一量级）。

- 区域入侵：连续 N_IN 帧确定在内即进入，在内满 min_duration_s 且当帧确定在内时发 start，此后每 UPDATE_S 发 update 保持物理告警，
  连续 N_OUT 帧确定在外发 end（exit）；轨迹消失超过 LOST_S 发 end（lost）。每条轨迹每次进入只告警一次。
- 有向越线：结构移植自 supervision LineZone（MIT，Copyright (c) 2022 Roboflow）："已确认侧"加"新侧连续 N_CROSS 帧"，
  骑线（|d| ≤ h）的帧跳过，只在线段两端外延 END_MARGIN_M 之内判定。轨迹消失期间保留已确认侧，遮挡中越线的目标
  重现后仍计一次，标为 inferred；消失前后的位移超过最大速度时视为编号错配，不计。同一轨迹同一方向 COOLDOWN_S 内只计一次。

方向约定：沿折线由第一点走向末点，forward 为从左法向 (−dy, dx) 一侧穿到另一侧；平面俯视 x 向右、y 向下（与地面映射一致），沿线前进看即从右侧穿到左侧。
摄像头只有按安装参数估算的地面映射时，位置可能有系统性偏差：事件一律为 suspected，只在控制台提示（不进入物理告警）。
时刻 now 为秒，只用于计时；状态只在本路串行调用的 update 中使用。
"""

import math
import uuid
from dataclasses import dataclass, field
from typing import Any, Literal

SMOOTH_N = 3  # 判定位置取最近几帧的均值（0.6 s）
H_MIN_M = 0.3  # 滞回带下限（米）
H_SIGMA = (
    2.0  # 滞回带取位置误差的倍数：1.5 倍时，误差与逐帧抖动相当的人在边界上站 60 s 约 5% 会误判一次
)
N_IN = 3  # 进入区域须连续确定在内的帧数（Frigate inertia 默认 3）
N_OUT = 3  # 离开区域须连续确定在外的帧数
N_CROSS = 3  # 越线须在新侧连续的帧数（0.6 s；平滑后相邻帧相关，2 帧不足以排除骑线抖动）
LOST_S = 5.0  # 轨迹消失超过此时长即丢弃其规则状态（与续接窗口 RELINK_S 一致）
UPDATE_S = 30.0  # 区域告警持续期间的重发间隔：使设备保持物理告警（解除时长 60 s）
GAP_S = 1.0  # 越线前后的观测间隔超过此时长即为遮挡中推断
END_MARGIN_M = 0.5  # 线段两端外延的判定余量
COOLDOWN_S = 2.0  # 同一轨迹同一方向的越线计数冷却
MAX_SPEED_MPS = {"person": 3.0}  # 跨遮挡推断越线时的最大速度；车辆不限
DEFAULT_MAX_SPEED_MPS = 40.0

type Phase = Literal["pulse", "start", "update", "end"]
type Direction = Literal["forward", "backward"]


@dataclass(frozen=True)
class Observation:
    """本帧一个目标：输出编号、类别、地面位置与误差（米）。"""

    track_id: int
    object_class: str
    x: float
    y: float
    sigma: float


@dataclass(frozen=True)
class RuleEvent:
    rule_id: str
    rule_name: str
    rule_type: Literal["intrusion", "line_crossing"]
    phase: Phase
    episode_id: uuid.UUID
    track_id: int
    object_class: str
    x: float
    y: float
    sigma: float
    since: float  # 状态开始时刻（区域为确认进入时刻，越线为越线时刻）
    direction: Direction | None = None
    inferred: bool = False
    end_reason: Literal["exit", "lost"] | None = None


def _band(sigma: float) -> float:
    return max(H_MIN_M, H_SIGMA * sigma)


def _segment_distance(
    px: float, py: float, a: tuple[float, float], b: tuple[float, float]
) -> float:
    dx, dy = b[0] - a[0], b[1] - a[1]
    length2 = dx * dx + dy * dy
    t = 0.0 if length2 == 0 else max(0.0, min(1.0, ((px - a[0]) * dx + (py - a[1]) * dy) / length2))
    return math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy))


def polygon_signed_distance(points: list[tuple[float, float]], x: float, y: float) -> float:
    """到多边形边界的距离，区内为正（射线法判内外）。"""
    inside = False
    n = len(points)
    for i in range(n):
        (x1, y1), (x2, y2) = points[i], points[(i + 1) % n]
        if (y1 > y) != (y2 > y) and x < x1 + (y - y1) * (x2 - x1) / (y2 - y1):
            inside = not inside
    distance = min(_segment_distance(x, y, points[i], points[(i + 1) % n]) for i in range(n))
    return distance if inside else -distance


def line_side(points: list[tuple[float, float]], x: float, y: float) -> float | None:
    """到折线的有符号距离，沿折线前进方向左侧为正；取最近的、垂足在其两端外延 END_MARGIN_M 之内的线段；
    都不在范围内（绕过线端）时为 None。"""
    best: tuple[float, float] | None = None  # (到线段的距离, 有符号距离)
    for a, b in zip(points, points[1:], strict=False):
        dx, dy = b[0] - a[0], b[1] - a[1]
        length = math.hypot(dx, dy)
        if length == 0:
            continue
        along = ((x - a[0]) * dx + (y - a[1]) * dy) / length
        if not -END_MARGIN_M <= along <= length + END_MARGIN_M:
            continue
        signed = (dx * (y - a[1]) - dy * (x - a[0])) / length  # 左法向 (−dy, dx)
        distance = _segment_distance(x, y, a, b)
        if best is None or distance < best[0]:
            best = (distance, signed)
    return None if best is None else best[1]


@dataclass
class _ZoneTrack:
    seen: float
    inside: bool = False
    in_count: int = 0
    out_count: int = 0
    entered: float = 0.0
    episode: uuid.UUID | None = None  # 已告警的这次进入
    sent: float = 0.0  # 上次发出 start/update 的时刻
    last: Observation | None = None


@dataclass
class _LineTrack:
    seen: float
    point: tuple[float, float]  # 上次观测位置（越线推断的速度校验）
    side: int | None = None  # 已确认侧：1 左、−1 右
    candidate: int = 0  # 在新侧连续的帧数
    jump: tuple[float, float] = (0.0, 0.0)  # 刚到新侧时与上一次观测的间隔（秒）与位移（米）
    counted: dict[str, float] = field(default_factory=dict)  # 方向 → 上次计数时刻


@dataclass(frozen=True)
class Rule:
    id: str
    name: str
    type: Literal["intrusion", "line_crossing"]
    points: list[tuple[float, float]]
    classes: frozenset[str]
    direction: Literal["forward", "backward", "any"] = "any"
    min_duration_s: float = 1.0

    @classmethod
    def parse(cls, raw: dict[str, Any]) -> "Rule":
        return cls(
            id=raw["id"],
            name=raw["name"],
            type=raw["type"],
            points=[(float(p[0]), float(p[1])) for p in raw["points"]],
            classes=frozenset(raw.get("classes") or ["person"]),
            direction=raw.get("direction") or "any",
            min_duration_s=float(raw.get("min_duration_s", 1.0)),
        )


class RuleEngine:
    """单路摄像头的全部规则。"""

    def __init__(self, rules: list[dict[str, Any]]) -> None:
        self._rules = [Rule.parse(r) for r in rules]
        self._zones: dict[tuple[str, int], _ZoneTrack] = {}
        self._lines: dict[tuple[str, int], _LineTrack] = {}
        self._recent: dict[
            int, tuple[float, list[tuple[float, float]]]
        ] = {}  # 轨迹 → (上次时刻, 近几帧位置)

    def __bool__(self) -> bool:
        return bool(self._rules)

    def update(self, observations: list[Observation], now: float) -> list[RuleEvent]:
        found: list[RuleEvent] = []
        observations = [self._smooth(obs, now) for obs in observations]
        for rule in self._rules:
            for obs in observations:
                if obs.object_class not in rule.classes:
                    continue
                if rule.type == "intrusion":
                    found += self._zone(rule, obs, now)
                else:
                    found += self._line(rule, obs, now)
        found += self._forget(now)
        return found

    def _smooth(self, obs: Observation, now: float) -> Observation:
        """最近 SMOOTH_N 帧位置的均值；中断超过 GAP_S 后重新开始，不把消失前的位置混入。"""
        last, points = self._recent.get(obs.track_id, (now, []))
        points = ([] if now - last > GAP_S else points)[-(SMOOTH_N - 1) :] + [(obs.x, obs.y)]
        self._recent[obs.track_id] = (now, points)
        x, y = (sum(p[i] for p in points) / len(points) for i in (0, 1))
        return Observation(obs.track_id, obs.object_class, x, y, obs.sigma)

    def _zone(self, rule: Rule, obs: Observation, now: float) -> list[RuleEvent]:
        state = self._zones.setdefault((rule.id, obs.track_id), _ZoneTrack(seen=now))
        state.seen, state.last = now, obs
        d = polygon_signed_distance(rule.points, obs.x, obs.y)
        h = _band(obs.sigma)
        if d > h:
            state.in_count, state.out_count = state.in_count + 1, 0
        elif d < -h:
            state.in_count, state.out_count = 0, state.out_count + 1
        events: list[RuleEvent] = []
        if not state.inside and state.in_count >= N_IN:
            state.inside, state.entered = True, now
        elif state.inside and state.out_count >= N_OUT:
            if state.episode is not None:
                events.append(self._zone_event(rule, state, "end", obs, end_reason="exit"))
            state.inside, state.episode = False, None
        if state.inside:
            if state.episode is None and d > h and now - state.entered >= rule.min_duration_s:
                state.episode, state.sent = uuid.uuid4(), now
                events.append(self._zone_event(rule, state, "start", obs))
            elif state.episode is not None and now - state.sent >= UPDATE_S:
                state.sent = now
                events.append(self._zone_event(rule, state, "update", obs))
        return events

    @staticmethod
    def _zone_event(
        rule: Rule,
        state: _ZoneTrack,
        phase: Phase,
        obs: Observation,
        end_reason: Literal["exit", "lost"] | None = None,
    ) -> RuleEvent:
        assert state.episode is not None
        return RuleEvent(
            rule.id, rule.name, "intrusion", phase, state.episode, obs.track_id,
            obs.object_class, obs.x, obs.y, obs.sigma, state.entered, end_reason=end_reason,
        )  # fmt: skip

    def _line(self, rule: Rule, obs: Observation, now: float) -> list[RuleEvent]:
        point = (obs.x, obs.y)
        state = self._lines.get((rule.id, obs.track_id))
        if state is None:
            state = self._lines[(rule.id, obs.track_id)] = _LineTrack(seen=now, point=point)
        previous_seen, previous_point = state.seen, state.point
        state.seen, state.point = now, point
        s = line_side(rule.points, obs.x, obs.y)
        if s is None or abs(s) <= _band(obs.sigma):
            return []  # 绕过线端或骑在线上：不改变已确认侧
        side = 1 if s > 0 else -1
        if state.side is None or side == state.side:
            state.side, state.candidate = side, 0
            return []
        if state.candidate == 0:
            # 刚到新侧：与上一次观测的间隔和位移，用于判断是否跨遮挡、位移是否可信
            state.jump = (now - previous_seen, math.dist(previous_point, point))
        state.candidate += 1
        if state.candidate < N_CROSS:
            return []
        state.side, state.candidate = side, 0
        gap, moved = state.jump
        inferred = gap > GAP_S
        limit = MAX_SPEED_MPS.get(obs.object_class, DEFAULT_MAX_SPEED_MPS)
        if inferred and moved > limit * gap:
            return []  # 消失前后的位移超出最大速度：多为编号错配，不计
        direction: Direction = "forward" if side < 0 else "backward"  # 左 → 右为 forward
        if rule.direction not in ("any", direction):
            return []
        if now - state.counted.get(direction, -math.inf) < COOLDOWN_S:
            return []
        state.counted[direction] = now
        return [
            RuleEvent(
                rule.id, rule.name, "line_crossing", "pulse", uuid.uuid4(), obs.track_id,
                obs.object_class, obs.x, obs.y, obs.sigma, now, direction=direction,
                inferred=inferred,
            )
        ]  # fmt: skip

    def _forget(self, now: float) -> list[RuleEvent]:
        """消失超过 LOST_S 的轨迹：区域内已告警的发 end（lost），状态丢弃。"""
        events = []
        by_id = {r.id: r for r in self._rules}
        for key, state in list(self._zones.items()):
            if now - state.seen <= LOST_S:
                continue
            if state.episode is not None and state.last is not None:
                events.append(
                    self._zone_event(by_id[key[0]], state, "end", state.last, end_reason="lost")
                )
            del self._zones[key]
        self._lines = {k: s for k, s in self._lines.items() if now - s.seen <= LOST_S}
        self._recent = {k: v for k, v in self._recent.items() if now - v[0] <= LOST_S}
        return events
