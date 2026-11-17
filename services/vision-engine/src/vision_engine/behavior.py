"""行为判定（FR-103、FR-104、C-CV-04）：按轨迹的骨骼几何与持续时间判定跌倒、攀爬、长时间静止与疑似打架。

输入为每帧已确认轨迹的 COCO 17 关键点（像素坐标，y 向下）与置信度；时刻 now 为秒，只用于计时。
每帧对每条轨迹的判定为"满足 / 不满足 / 无法判断（关键点不可见）"：不满足即中断计时；
无法判断或轨迹漏检不超过 GAP_S 时不中断，以容忍偶发漏检。

跌倒分两级（TK-160）：倒地姿态满 MIN_DURATION_S 发"疑似"，只在控制台提示；倒地且髋部基本不动满
CONFIRM_S 才"确认"，进入物理告警，此后每 REPEAT_S 重发。期间站起即中断，不再确认。弯腰捡物、
短暂蹲坐与在地上活动（爬行、做运动）多在确认前站起或移动，不进入物理告警。倒地前 TRANSITION_S 内
没有看到这条轨迹直立（一出现就躺着，可能是躺卧休息）时，确认要求不动满 CONFIRM_UNSEEN_S。

长时间静止同样分两级：站着的人髋部停在原处满 STILL_SUSPECT_S 发"疑似"，满 STILL_CONFIRM_S "确认"；
只对站姿计时（看得到伸直的腿）：坐在工位上不动是常态，办公室里会一直误提示；倒地的交给跌倒判定。

原地消失是跌倒的补充线索，只有"疑似"一级：站着的人在画面中间（不贴边）突然没了轨迹，满 VANISH_S
附近也没有新轨迹出现，多是倒下后被桌椅挡住、或横躺后检测器认不出（现场实测：倒地后整段检测不到）。
走到柱子、他人身后同样会触发，所以只供值班员看画面确认，不进入物理告警、不参与关联。

打架只有"疑似"一级：两人伸手可及、手腕相对身体快速运动、两人整体又没有一起移动（并肩跑步、同行不算），
在 FIGHT_WINDOW_S 内过半的帧都如此才提示。这是骨骼几何的启发式判定，没有经真实打架素材校准，只供值班员留意，
不进入物理告警、不参与关联。

配置了骨骼动作模型（action.py，STGCN++）时，规则与模型同时成立可加快或升级判定：
- 跌倒：已发疑似（倒地满 MIN_DURATION_S）、且模型近 FALL_MODEL_RECENT_S 内认为这条轨迹在跌倒（概率不低于
  FALL_MODEL_PROB），不必再等倒地不动满 CONFIRM_S 即确认。模型只认动作过程，倒下之后静躺时概率回落，
  所以只作提前确认的依据；没看到跌倒过程（被挡、一出现就躺着）时仍按原规则确认。规则没看到倒地（朝镜头倒、
  倒在桌后）而模型的跌倒概率不低于 FALL_MODEL_ALONE_PROB 时，单独发"疑似"，只在控制台提示
- 打架：两人伸手可及、躯干长短相当（同一深度），且模型近 FIGHT_MODEL_WINDOW_S 内至少 FIGHT_MODEL_HITS 次认为
  在打人、踢人或推人（三类概率之和不低于 FIGHT_MODEL_PROB），即确认、进入物理告警；只有规则成立时仍为疑似
"""

import math
from dataclasses import dataclass, field
from typing import Literal

import numpy as np

from vision_engine.action import ActionRecognizer

MIN_DURATION_S = 2.0  # 持续时长门限（C-CV-04 默认 min_duration）
MIN_CONFIDENCE = 0.5  # 判定所用关键点置信度的均值门限（C-CV-04）
REPEAT_S = 30.0  # 持续满足时的重发间隔：使设备保持物理告警（解除时长 60 s，ui.md §5.1）
GAP_S = 1.0  # 漏检或无法判断不超过此时长时不中断计时
FORGET_S = 10.0  # 轨迹消失超过此时长即丢弃其判定状态
KEYPOINT_MIN = 0.3  # 关键点置信度低于此值视为不可见
FALL_TORSO_DEG = 60.0  # 躯干（髋→肩）与竖直向上方向的夹角下限
FALL_HIP_RATIO = 0.5  # 髋部高出腿部最低点的距离 / 躯干长度 的上限：髋部接近地面
# 已发出跌倒事件后改用更宽的门限（回差）：倒地者在门限附近的逐帧抖动不中断，一次跌倒不拆成多条事件
# （#134）；站起（躯干接近竖直或髋部抬高）仍立即中断。发出前仍按进入门限，不因回差延长可疑姿态而误报
FALL_EXIT_TORSO_DEG = 45.0
FALL_EXIT_HIP_RATIO = 0.75
# 确认跌倒（两级告警）。大华跌倒规则首次告警默认 10 s、Rougier 等要求倒地后 5 s 内不动（见动作识别调研）；
# 确认晚几秒对救助时效几乎没有影响，却能滤掉弯腰、捡物、短暂蹲坐
CONFIRM_S = 8.0  # 倒地满此时长且近 STILL_WINDOW_S 内基本不动即确认
CONFIRM_UNSEEN_S = 30.0  # 倒地前没看到直立时的确认时长
TRANSITION_S = 5.0  # 倒地前此时长内看到直立（不满足倒地姿态的一帧），即视为看到了跌倒过程
STILL_WINDOW_S = 4.0
STILL_RATIO = 1.0  # 窗口内髋部的净位移 / 躯干长度 的上限：倒地者挣扎、翻身仍在此内，爬行会超出

# 长时间静止：未倒地的人髋部相对起点的位移不超过躯干长度的 STILL_LONG_RATIO 倍
STILL_SUSPECT_S = (
    120.0  # 满此时长发疑似；人流素材 crowd-1 中常态的原地停留最长约 80 s，其余不足 20 s
)
STILL_CONFIRM_S = 300.0  # 满此时长确认，此后每 REPEAT_S 重发
STILL_LONG_RATIO = 0.5  # 原地转身、挥手、伏案仍在此内，挪一步即超出
STILL_GAP_S = 5.0  # 髋部看不清或轨迹漏检超过此时长即重新计：遮挡期间无法确认仍在原处
# 疑似打架：按"躯干长度"归一，不依赖标定与画面远近
FIGHT_REACH = 2.5  # 两人髋部中点的距离 / 两人躯干长度的均值 的上限：伸手可及
FIGHT_DEPTH_RATIO = 1.6  # 两人躯干长度之比的上限：画面上重叠、实际一前一后的两人躯干长短悬殊
FIGHT_WRIST_SPEED = 3.0  # 手腕相对髋部的速度（躯干长度 / 秒）：出拳、推搡远高于走路摆臂（约 1）
FIGHT_BOTH_RATIO = 0.5  # 另一人的手腕速度至少为上值的此倍数：双方都在动
FIGHT_DRIFT_SPEED = 1.5  # 两人中点的移动速度（躯干长度 / 秒）上限：并肩奔跑时手臂也快，但整体在移动
FIGHT_WINDOW_S = 4.0  # 判定窗口
FIGHT_MIN_SPAN_S = 3.0  # 窗口内样本须覆盖的时长
FIGHT_ACTIVE_RATIO = 0.5  # 窗口内满足以上条件的帧占比
# 原地消失：按"躯干长度"与画面尺寸归一，不依赖标定
# 骨骼动作模型复核（action.py）：阈值在本地录制片段上核对（models/cards/stgcnpp-ntu60-2d.md）
FALL_MODEL_PROB = 0.6  # 真实跌倒 0.63～1.0；5 分钟人流、跳跃、下蹲、攀爬最高 0.49
FALL_MODEL_ALONE_PROB = 0.65  # 只有模型看到跌倒时发疑似的门限：本地片段中真实跌倒 0.65～0.95（随推理时刻浮动），人流最高 0.58
FALL_MODEL_RECENT_S = (
    6.0  # 跌倒动作在倒地前后约 1～3 s 内被认出，到发疑似（倒地满 2 s）时须仍在此时长内
)
FIGHT_MODEL_PROB = 0.6
FIGHT_MODEL_WINDOW_S = 3.5  # 约 3 次推理
FIGHT_MODEL_HITS = 2
VANISH_S = 3.0  # 轨迹消失满此时长、附近没有新轨迹出现，才判为原地消失
VANISH_STAND_S = 3.0  # 消失前此时长内须看到站姿：坐着的人俯身到桌下不算
VANISH_STAND_FRAMES = 3  # 上述时长内站姿帧数的下限
VANISH_STAND_HIP = 0.5  # 站姿：躯干直立，且髋部离地 / 躯干长度 不低于此值（坐着时多在 0.35 以下）
VANISH_EDGE = 0.05  # 最后位置的关键点外框距画面边缘不足画面尺寸的此比例：多是走出画面，不算
VANISH_NEAR = 2.0  # 消失后出现的新轨迹髋部距消失处不超过此倍躯干长度：同一人换了编号，不算
VANISH_MIN_LIFE_S = 3.0  # 轨迹须存在满此时长：人流中一闪而过、频繁换编号的轨迹不算
# 消失前 VANISH_SPEED_S 内髋部的移动速度（躯干长度 / 秒）上限：边走边消失的多是走远变小、走到他人身后。
# 人流素材 crowd-1 中这类消失均不低于 1.0；现场实测倒地前站着、慢慢挪步为 0.25
VANISH_SPEED_S = 2.0
VANISH_MAX_SPEED = 0.6
VANISH_MIN_HEIGHT = (
    0.12  # 最后外框高度不足画面高度的此比例：远处的小人本就易漏检，不算（实测倒地者为 0.16）
)
VANISH_SPEED_SPAN_S = 0.4  # 上述时长内髋部样本须覆盖的时长：样本不足时无从判断是否在走，不发出

SHOULDERS, HIPS, LEGS, ANKLES = (5, 6), (11, 12), (13, 14, 15, 16), (15, 16)
WRISTS = (9, 10)

type Kind = Literal["fall", "climb", "still", "fight"]
type Level = Literal["suspected", "confirmed"]


@dataclass(frozen=True)
class Behavior:
    track_id: int
    behavior: Kind
    confidence_avg: float
    start: float
    end: float
    level: Level = "confirmed"


def _visible(scores: np.ndarray, idx: tuple[int, ...]) -> list[int]:
    return [i for i in idx if scores[i] >= KEYPOINT_MIN]


@dataclass(frozen=True)
class FallMeasure:
    """一帧的倒地几何量（FR-103）：fall_frame 据此判定，诊断工具 tools/dev/explain_behavior.py 据此解释。"""

    tilt_deg: float  # 躯干（髋→肩）与竖直向上方向的夹角：0° 为直立，180° 为倒立
    hip_ratio: float  # 髋部高出腿部最低点的距离 / 躯干长度
    score: float  # 所用关键点（肩、髋、腿）置信度的均值


def fall_measure(points: np.ndarray, scores: np.ndarray) -> FallMeasure | None:
    """肩、髋、腿（膝或踝）任一不可见，或躯干长度为 0 时为 None（无法判断）。"""
    shoulders, hips, legs = (_visible(scores, idx) for idx in (SHOULDERS, HIPS, LEGS))
    if not shoulders or not hips or not legs:
        return None
    hip = points[hips].mean(axis=0)
    dx, dy = points[shoulders].mean(axis=0) - hip
    torso = math.hypot(dx, dy)
    if torso == 0:
        return None
    return FallMeasure(
        tilt_deg=math.degrees(math.atan2(abs(dx), -dy)),
        hip_ratio=float((points[legs, 1].max() - hip[1]) / torso),
        score=float(scores[shoulders + hips + legs].mean()),
    )


def fall_thresholds(falling: bool) -> tuple[float, float]:
    """（躯干倾角下限, 髋部高度上限）：已发出跌倒事件的轨迹按退出门限（回差，#134）。"""
    return (
        (FALL_EXIT_TORSO_DEG, FALL_EXIT_HIP_RATIO) if falling else (FALL_TORSO_DEG, FALL_HIP_RATIO)
    )


def fall_frame(
    points: np.ndarray, scores: np.ndarray, falling: bool = False
) -> tuple[bool, float] | None:
    """躯干倾角与髋部高度（FR-103）。返回（是否满足, 所用关键点置信度均值）；不可见为 None。
    falling 为该轨迹已发出跌倒事件，按退出门限判定。"""
    measure = fall_measure(points, scores)
    if measure is None:
        return None
    tilt_min, hip_max = fall_thresholds(falling)
    return measure.tilt_deg > tilt_min and measure.hip_ratio < hip_max, measure.score


STAND_KNEE_DEG = 150.0  # 髋—膝—踝夹角不小于此值：腿伸直
STAND_TORSO_DEG = 30.0  # 躯干偏离竖直不超过此值


def standing_frame(points: np.ndarray, scores: np.ndarray) -> bool:
    """站姿：躯干直立，且至少一条腿（髋、膝、踝都看得见）伸直。腿看不清时按非站姿（多是坐在桌后）。"""
    shoulders, hips = _visible(scores, SHOULDERS), _visible(scores, HIPS)
    if not shoulders or not hips:
        return False
    dx, dy = points[shoulders].mean(axis=0) - points[hips].mean(axis=0)
    if dy >= 0 or math.degrees(math.atan2(abs(dx), -dy)) > STAND_TORSO_DEG:
        return False
    for hip, knee, ankle in ((11, 13, 15), (12, 14, 16)):
        if min(scores[hip], scores[knee], scores[ankle]) < KEYPOINT_MIN:
            continue
        a, b = points[hip] - points[knee], points[ankle] - points[knee]
        cos = float(a @ b / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-9))
        if math.degrees(math.acos(max(-1.0, min(1.0, cos)))) >= STAND_KNEE_DEG:
            return True
    return False


def hip_and_torso(points: np.ndarray, scores: np.ndarray) -> tuple[np.ndarray, float] | None:
    """髋部中点与躯干长度（像素），用于判断倒地后是否在动；肩或髋不可见时为 None。"""
    shoulders, hips = _visible(scores, SHOULDERS), _visible(scores, HIPS)
    if not shoulders or not hips:
        return None
    hip = points[hips].mean(axis=0)
    torso = float(np.linalg.norm(points[shoulders].mean(axis=0) - hip))
    return (hip, torso) if torso > 0 else None


@dataclass
class ClimbLine:
    """警戒线 [u1, v1, u2, v2]（FR-104）。脚踝在线段范围内时，按位于线的哪一侧区分线下与线上。"""

    u1: float
    v1: float
    u2: float
    v2: float

    def __post_init__(self) -> None:
        # 与 api-server 的校验一致；不依赖登记表已在上游拦截
        if self.u1 == self.u2:
            raise ValueError(f"警戒线不能是竖直线段：{[self.u1, self.v1, self.u2, self.v2]}")

    def side(self, u: float, v: float) -> Literal["below", "above"] | None:
        """线段范围外（垂足不在线段上）为 None。"""
        du, dv = self.u2 - self.u1, self.v2 - self.v1
        t = ((u - self.u1) * du + (v - self.v1) * dv) / (du * du + dv * dv)
        if not 0 <= t <= 1:
            return None
        cross = du * (v - self.v1) - dv * (u - self.u1)
        # 竖直向上的方向 (0, -1) 与线的叉积为 -du：与之同号的一侧为线上
        return "above" if cross * -du > 0 else "below"


@dataclass
class _Timer:
    """一条轨迹的一种行为：满足的持续时间、置信度与上次发出时刻。"""

    start: float | None = None
    last: float = -math.inf
    # 本次计时内各帧置信度的累计与帧数：只记累计，长时间持续的行为不逐帧多存一项、也不每帧重新求和。
    # 按 Neumaier 补偿求和累计（total 为和、lost 为舍入丢掉的部分），与内置 sum 对同一串数的结果逐位相同
    total: float = 0.0
    lost: float = 0.0
    count: int = 0
    emitted: float | None = None

    @property
    def mean(self) -> float:
        return (self.total + self.lost) / self.count

    def _add(self, score: float) -> None:
        total = self.total + score
        if abs(self.total) >= abs(score):
            self.lost += (self.total - total) + score
        else:
            self.lost += (score - total) + self.total
        self.total, self.count = total, self.count + 1

    def update(self, ok: bool | None, score: float, now: float) -> tuple[float, float] | None:
        """返回需发出事件的（开始时刻, 置信度均值）。"""
        if ok is None:
            return None
        if not ok:
            self.start, self.emitted = None, None
            return None
        if self.start is None or now - self.last > GAP_S:
            self.start, self.emitted = now, None
            self.total, self.lost, self.count = 0.0, 0.0, 0
        self.last = now
        self._add(score)
        due = self.emitted is None or now - self.emitted >= REPEAT_S
        if now - self.start >= MIN_DURATION_S and self.mean >= MIN_CONFIDENCE and due:
            self.emitted = now
            return self.start, self.mean
        return None


@dataclass
class _Fall:
    """一条轨迹的跌倒两级判定。"""

    timer: _Timer = field(default_factory=_Timer)  # 倒地姿态的持续：满 MIN_DURATION_S 发疑似
    upright: float = -math.inf  # 最近一次看到直立（不满足倒地姿态）的时刻
    lying: float | None = None  # 自上次直立后首次倒地的时刻；漏检使计时重新开始时不变
    hips: list[tuple[float, np.ndarray, float]] = field(
        default_factory=list
    )  # 近期（时刻, 髋, 躯干）
    confirmed: float | None = None  # 上次发出确认的时刻

    @property
    def suspected(self) -> bool:
        return self.timer.emitted is not None

    def update(
        self,
        ok: bool | None,
        score: float,
        hip: tuple[np.ndarray, float] | None,
        now: float,
        model: float = 0.0,
    ) -> list[tuple[Level, float, float]]:
        """返回需发出的（级别, 开始时刻, 置信度均值）。model 为动作模型近期的跌倒概率峰值（没有模型时为 0）。"""
        if ok is None:
            return []
        start = self.timer.start
        hit = self.timer.update(ok, score, now)
        if not ok:
            self.upright, self.lying, self.hips, self.confirmed = now, None, [], None
            return []
        if self.timer.start != start:  # 漏检超过 GAP_S 后重新计时：确认也重新计
            self.hips, self.confirmed = [], None
        if self.lying is None:
            self.lying = now
        found: list[tuple[Level, float, float]] = []
        if hit is not None and self.confirmed is None:
            found.append(("suspected", *hit))
        if hip is not None:
            self.hips.append((now, *hip))
        self.hips = [h for h in self.hips if now - h[0] <= STILL_WINDOW_S]
        start, mean = self.timer.start, self.timer.mean
        assert start is not None
        seen_fall = self.lying - self.upright <= TRANSITION_S
        needed = CONFIRM_S if seen_fall else CONFIRM_UNSEEN_S
        due = self.confirmed is None or now - self.confirmed >= REPEAT_S
        seen_by_model = self.confirmed is None and model >= FALL_MODEL_PROB
        if self.suspected and due and (seen_by_model or (now - start >= needed and self._still())):
            self.confirmed = now
            found.append(("confirmed", start, mean))
        return found

    def _still(self) -> bool:
        """近 STILL_WINDOW_S 内髋部的净位移不超过躯干长度的 STILL_RATIO 倍；窗口内不足两帧时不确认。"""
        if len(self.hips) < 2:
            return False
        torso = float(np.median([h[2] for h in self.hips]))
        return float(np.linalg.norm(self.hips[-1][1] - self.hips[0][1])) <= STILL_RATIO * torso


@dataclass
class _Still:
    """一条轨迹的长时间静止两级判定：只记起点，不逐帧存历史。"""

    anchor: np.ndarray | None = None  # 本次静止开始时的髋部位置
    start: float = 0.0
    last: float = -math.inf
    total: float = 0.0
    count: int = 0
    suspected: bool = False
    confirmed: float | None = None

    def reset(self) -> None:
        self.anchor, self.suspected, self.confirmed = None, False, None

    def update(
        self,
        hip: tuple[np.ndarray, float] | None,
        score: float,
        lying: bool,
        now: float,
        standing: bool = True,
    ) -> list[tuple[Level, float, float]]:
        """返回需发出的（级别, 开始时刻, 置信度均值）。lying：本帧为倒地姿态，由跌倒判定负责；
        standing 为假（坐、蹲，或腿看不清）时不计时。"""
        if lying or not standing:
            self.reset()
            return []
        if hip is None:
            return []
        center, torso = hip
        moved = (
            self.anchor is None
            or now - self.last > STILL_GAP_S
            or float(np.linalg.norm(center - self.anchor)) > STILL_LONG_RATIO * torso
        )
        if moved:
            self.reset()
            self.anchor, self.start, self.total, self.count = center, now, 0.0, 0
        self.last = now
        self.total, self.count = self.total + score, self.count + 1
        mean, held = self.total / self.count, now - self.start
        if mean < MIN_CONFIDENCE:
            return []
        found: list[tuple[Level, float, float]] = []
        if held >= STILL_SUSPECT_S and not self.suspected:
            self.suspected = True
            found.append(("suspected", self.start, mean))
        due = self.confirmed is None or now - self.confirmed >= REPEAT_S
        if held >= STILL_CONFIRM_S and due:
            self.confirmed = now
            found.append(("confirmed", self.start, mean))
        return found


@dataclass
class _Body:
    """一条轨迹在一帧中用于打架判定的量：髋部、躯干长度、可见手腕相对髋部的位置。"""

    at: float
    hip: np.ndarray
    torso: float
    wrists: dict[int, np.ndarray]
    score: float
    speed: float | None = None  # 手腕相对髋部的最大速度（躯干长度 / 秒）；没有上一帧可比时为 None


@dataclass
class _Pair:
    """两条轨迹之间的打架判定：窗口内各帧是否满足，与上次提示的时刻。"""

    frames: list[tuple[float, bool, float]] = field(
        default_factory=list
    )  # (时刻, 是否满足, 置信度)
    center: tuple[float, np.ndarray] | None = None  # 上一帧两人中点
    emitted: float | None = None
    confirmed: float | None = None  # 上次按动作模型确认的时刻


def _lingered(trail: list[tuple[float, np.ndarray, float]]) -> bool:
    """消失前 VANISH_SPEED_S 内髋部移动不超过 VANISH_MAX_SPEED（躯干长度 / 秒）：站着或慢慢挪步，
    不是边走边消失。"""
    if len(trail) < 2 or trail[-1][0] - trail[0][0] < VANISH_SPEED_SPAN_S:
        return False
    torso = float(np.median([h[2] for h in trail]))
    moved = float(np.linalg.norm(trail[-1][1] - trail[0][1]))
    return moved / torso / (trail[-1][0] - trail[0][0]) <= VANISH_MAX_SPEED


@dataclass
class _Track:
    seen: float
    first: float = 0.0  # 首次出现的时刻
    stood: list[float] = field(default_factory=list)  # 近 VANISH_STAND_S 内站姿帧的时刻
    stand_score: float = 0.0  # 最近一次站姿帧的关键点置信度
    hip: tuple[np.ndarray, float] | None = None  # 最近一次可见的（髋部, 躯干长度）
    box: tuple[float, float, float, float] | None = None  # 最近一次可见关键点的外框
    trail: list[tuple[float, np.ndarray, float]] = field(
        default_factory=list
    )  # 近 VANISH_SPEED_S 内的（时刻, 髋部, 躯干长度）：判断消失前是否在走
    vanished: bool = False  # 已判过原地消失（无论是否发出），不再重判
    fall: _Fall = field(default_factory=_Fall)
    model_fall: float | None = None  # 只按动作模型发出疑似跌倒的时刻
    still: _Still = field(default_factory=_Still)
    body: _Body | None = None
    climbs: dict[int, _Timer] = field(default_factory=dict)
    below: set[int] = field(default_factory=set)  # 脚踝出现过在其下方的警戒线


def _body(
    previous: _Body | None,
    hip: tuple[np.ndarray, float] | None,
    points: np.ndarray,
    scores: np.ndarray,
    score: float,
    now: float,
) -> _Body | None:
    """本帧的髋部、躯干与手腕；与上一帧（不超过 GAP_S 前）都可见的手腕算出相对髋部的速度。"""
    if hip is None:
        return None
    center, torso = hip
    wrists = {i: points[i] - center for i in _visible(scores, WRISTS)}
    body = _Body(now, center, torso, wrists, score)
    if previous is not None and 0 < now - previous.at <= GAP_S:
        moved = [
            float(np.linalg.norm(at - previous.wrists[i]))
            for i, at in wrists.items()
            if i in previous.wrists
        ]
        if moved:
            body.speed = max(moved) / (now - previous.at) / torso
    return body


def _fight_frame(pair: _Pair, a: _Body, b: _Body, now: float) -> tuple[float, float] | None:
    """记入本帧两人是否像在打架；窗口内过半满足且到了提示的时候，返回（开始时刻, 置信度均值）。"""
    torso = (a.torso + b.torso) / 2
    center = (a.hip + b.hip) / 2
    drift = None
    if pair.center is not None and 0 < now - pair.center[0] <= GAP_S:
        drift = float(np.linalg.norm(center - pair.center[1])) / (now - pair.center[0]) / torso
    pair.center = (now, center)
    fast, slow = max(a.speed or 0.0, b.speed or 0.0), min(a.speed or 0.0, b.speed or 0.0)
    active = (
        float(np.linalg.norm(a.hip - b.hip)) <= FIGHT_REACH * torso
        and max(a.torso, b.torso) <= FIGHT_DEPTH_RATIO * min(a.torso, b.torso)
        and fast >= FIGHT_WRIST_SPEED
        and slow >= FIGHT_WRIST_SPEED * FIGHT_BOTH_RATIO
        and drift is not None
        and drift <= FIGHT_DRIFT_SPEED
    )
    pair.frames.append((now, active, (a.score + b.score) / 2))
    pair.frames = [f for f in pair.frames if now - f[0] <= FIGHT_WINDOW_S]
    hits = [f for f in pair.frames if f[1]]
    if (
        now - pair.frames[0][0] < FIGHT_MIN_SPAN_S
        or len(hits) < FIGHT_ACTIVE_RATIO * len(pair.frames)
        or (pair.emitted is not None and now - pair.emitted < REPEAT_S)
    ):
        return None
    mean = float(np.mean([f[2] for f in hits]))
    if mean < MIN_CONFIDENCE:
        return None
    pair.emitted = now
    return hits[0][0], mean


class BehaviorDetector:
    """单路摄像头的判定状态；只在该路串行调用的 update 中使用。"""

    def __init__(
        self, climb_lines: list[list[float]], actions: ActionRecognizer | None = None
    ) -> None:
        self._lines = [ClimbLine(*line) for line in climb_lines]
        self._actions = actions  # None 时只按骨骼几何规则判定
        self._tracks: dict[int, _Track] = {}
        self._pairs: dict[tuple[int, int], _Pair] = {}

    def update(
        self,
        track_ids: np.ndarray,
        keypoints: np.ndarray,
        scores: np.ndarray,
        now: float,
        frame_size: tuple[int, int] | None = None,
    ) -> list[Behavior]:
        """track_ids (N,)、keypoints (N, 17, 2)、scores (N, 17) 为本帧已确认的轨迹，可以为空：画面中没有人时
        同样须调用，消失的轨迹才能按时判定原地消失。frame_size 为画面（宽, 高），不给时不判原地消失。"""
        found = []
        present: list[int] = []
        if self._actions is not None:
            self._actions.update(track_ids, keypoints, scores, now)
        for track_id, points, kp_scores in zip(track_ids, keypoints, scores, strict=True):
            track = self._tracks.setdefault(int(track_id), _Track(seen=now, first=now))
            track.seen = now
            self._observe(track, points, kp_scores, now)
            fall = fall_frame(points, kp_scores, falling=track.fall.suspected)
            ok, score = fall if fall is not None else (None, 0.0)
            hip = hip_and_torso(points, kp_scores)
            model = (
                self._actions.fall_peak(int(track_id), now, FALL_MODEL_RECENT_S)
                if self._actions is not None
                else 0.0
            )
            for level, start, mean in track.fall.update(ok, score, hip, now, model):
                found.append(Behavior(int(track_id), "fall", mean, start, now, level))
            if (
                model >= FALL_MODEL_ALONE_PROB
                and not track.fall.suspected
                and (track.model_fall is None or now - track.model_fall >= REPEAT_S)
            ):
                # 规则没看到倒地、模型认为在跌倒：只发疑似，置信度取模型概率
                track.model_fall = now
                found.append(Behavior(int(track_id), "fall", model, now, now, "suspected"))
            for hit in self._climb(track, points, kp_scores, now):
                found.append(Behavior(int(track_id), "climb", hit[1], hit[0], now))
            trunk = float(kp_scores[list(SHOULDERS + HIPS)].mean())
            upright = standing_frame(points, kp_scores)
            for level, start, mean in track.still.update(hip, trunk, bool(ok), now, upright):
                found.append(Behavior(int(track_id), "still", mean, start, now, level))
            track.body = _body(track.body, hip, points, kp_scores, trunk, now)
            if track.body is not None and not ok:  # 倒地的人不参与打架判定
                present.append(int(track_id))
        found += self._fights(sorted(present), now)
        if frame_size is not None:
            found += self._vanishes({int(i) for i in track_ids}, frame_size, now)
        self._tracks = {k: t for k, t in self._tracks.items() if now - t.seen <= FORGET_S}
        self._pairs = {
            k: p for k, p in self._pairs.items() if k[0] in self._tracks and k[1] in self._tracks
        }
        return found

    @staticmethod
    def _observe(track: _Track, points: np.ndarray, scores: np.ndarray, now: float) -> None:
        """记下原地消失判定所需的最近状态：站姿时刻、髋部与可见关键点外框。"""
        if (hip := hip_and_torso(points, scores)) is not None:
            track.hip = hip
            track.trail.append((now, *hip))
        track.trail = [h for h in track.trail if now - h[0] <= VANISH_SPEED_S]
        seen = points[scores >= KEYPOINT_MIN]
        if len(seen) >= 2:
            (x0, y0), (x1, y1) = seen.min(axis=0), seen.max(axis=0)
            track.box = (float(x0), float(y0), float(x1), float(y1))
        measure = fall_measure(points, scores)
        if (
            measure is not None
            and measure.tilt_deg <= STAND_TORSO_DEG
            and measure.hip_ratio >= VANISH_STAND_HIP
        ):
            track.stood.append(now)
            track.stand_score = measure.score
        track.stood = [t for t in track.stood if now - t <= VANISH_STAND_S]

    def _vanishes(
        self, present: set[int], frame_size: tuple[int, int], now: float
    ) -> list[Behavior]:
        """消失满 VANISH_S 的轨迹各判一次：消失前站着、最后位置不贴边、附近没有新轨迹出现。"""
        width, height = frame_size
        found = []
        for track_id, track in self._tracks.items():
            if track_id in present or track.vanished or now - track.seen < VANISH_S:
                continue
            track.vanished = True
            stood = [t for t in track.stood if track.seen - t <= VANISH_STAND_S]
            if (
                track.fall.suspected
                or len(stood) < VANISH_STAND_FRAMES
                or track.stand_score < MIN_CONFIDENCE
                or track.seen - track.first < VANISH_MIN_LIFE_S
            ):
                continue
            if track.box is None or track.hip is None:
                continue
            x0, y0, x1, y1 = track.box
            margin_x, margin_y = VANISH_EDGE * width, VANISH_EDGE * height
            if x0 < margin_x or y0 < margin_y or x1 > width - margin_x or y1 > height - margin_y:
                continue
            if y1 - y0 < VANISH_MIN_HEIGHT * height:
                continue
            if not _lingered(track.trail):
                continue
            hip, torso = track.hip
            if any(
                other.first >= track.seen - GAP_S
                and other.hip is not None
                and float(np.linalg.norm(other.hip[0] - hip)) <= VANISH_NEAR * torso
                for other_id, other in self._tracks.items()
                if other_id != track_id
            ):
                continue  # 同一人换了编号：新轨迹自行判定，倒地时由跌倒判定接手
            found.append(
                Behavior(track_id, "fall", track.stand_score, track.seen, now, "suspected")
            )
        return found

    def _fights(self, present: list[int], now: float) -> list[Behavior]:
        """本帧在场的轨迹两两判定；满足时对双方各发一条疑似。"""
        found = []
        for i, a_id in enumerate(present):
            for b_id in present[i + 1 :]:
                a, b = self._tracks[a_id].body, self._tracks[b_id].body
                assert a is not None and b is not None
                pair = self._pairs.setdefault((a_id, b_id), _Pair())
                hit = _fight_frame(pair, a, b, now)
                if (confirmed := self._fight_confirmed(pair, (a_id, b_id), a, b, now)) is not None:
                    found += [
                        Behavior(
                            track_id,
                            "fight",
                            confirmed,
                            now - FIGHT_MODEL_WINDOW_S,
                            now,
                            "confirmed",
                        )
                        for track_id in (a_id, b_id)
                    ]
                    continue
                if hit is None:
                    continue
                start, mean = hit
                found += [
                    Behavior(track_id, "fight", mean, start, now, "suspected")
                    for track_id in (a_id, b_id)
                ]
        return found

    def _fight_confirmed(
        self, pair: _Pair, ids: tuple[int, int], a: _Body, b: _Body, now: float
    ) -> float | None:
        """两人伸手可及、同一深度，且动作模型近期多次认为在打人、踢人或推人：返回置信度（两人关键点置信度均值）。"""
        if self._actions is None:
            return None
        if pair.confirmed is not None and now - pair.confirmed < REPEAT_S:
            return None
        torso = (a.torso + b.torso) / 2
        if float(np.linalg.norm(a.hip - b.hip)) > FIGHT_REACH * torso or max(
            a.torso, b.torso
        ) > FIGHT_DEPTH_RATIO * min(a.torso, b.torso):
            return None
        hits = self._actions.fight_hits(ids, now, FIGHT_MODEL_WINDOW_S, FIGHT_MODEL_PROB)
        if hits < FIGHT_MODEL_HITS:
            return None
        pair.confirmed = pair.emitted = now
        return (a.score + b.score) / 2

    def _climb(
        self, track: _Track, points: np.ndarray, scores: np.ndarray, now: float
    ) -> list[tuple[float, float]]:
        """脚踝在警戒线下方出现过、随后越到线上方（FR-104）。脚踝不可见时不中断计时。"""
        ankles = _visible(scores, ANKLES)
        if not ankles:
            return []
        u, v = points[ankles].mean(axis=0)
        score = float(scores[ankles].mean())
        hits = []
        for i, line in enumerate(self._lines):
            side = line.side(u, v)
            if side == "below":
                track.below.add(i)
            ok = side == "above" and i in track.below
            if (hit := track.climbs.setdefault(i, _Timer()).update(ok, score, now)) is not None:
                hits.append(hit)
        return hits
