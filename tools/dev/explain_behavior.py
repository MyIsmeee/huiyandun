"""跌倒判定的逐帧诊断（TK-160）：按与检测链路相同的方式回放一段骨骼轨迹，逐段说明每条轨迹在每一刻满足或
不满足哪一项条件，最后给出结论与调整建议。用于现场调试：录下测试动作，查明问题出在机位、动作还是阈值。

用法：uv run --all-packages python tools/dev/explain_behavior.py <片段.npz | 视频文件 | RTSP 地址> [--track ID] [--detail]

- 输入 .npz（tools/dev/record_keypoints.py 录制）直接回放；输入视频文件时先经同一链路录制为同名 .npz 再回放。
- 输入 RTSP 地址时录 --seconds 秒（默认 60）存为 --save 指定的 .npz（默认 live.npz）再回放：在视觉引擎容器内
  从 rtsp://go2rtc:8554/<摄像头编号> 取流，不需要摄像头口令，录到的就是线上分析的同一路画面
- 录制需要 RTMO 与 RF-DETR 模型：未设 HYD_MODEL_FILE、HYD_VEHICLE_MODEL_FILE 时取 models/weights 中与
  deploy/compose/compose.yaml 相同的文件；未设 HYD_DEVICE 时用 CPU
- 判定与阈值全部取自 vision_engine.behavior：逐帧调用 BehaviorDetector，只读它为每条轨迹保存的跌倒状态，
  不另写一套判定，结论与线上一致
"""

import argparse
import importlib.util
import os
import sys
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import yaml

from vision_engine.behavior import (
    CONFIRM_S,
    CONFIRM_UNSEEN_S,
    GAP_S,
    HIPS,
    KEYPOINT_MIN,
    LEGS,
    MIN_CONFIDENCE,
    MIN_DURATION_S,
    SHOULDERS,
    STAND_TORSO_DEG,
    TRANSITION_S,
    VANISH_S,
    Behavior,
    BehaviorDetector,
    fall_measure,
    fall_thresholds,
)

ROOT = Path(__file__).resolve().parents[2]
MIN_FRAMES = 5  # 少于此帧数的轨迹多为误检或一闪而过，默认不列出
PARTS = (("肩", SHOULDERS), ("髋", HIPS), ("腿", LEGS))
MISSING, UPRIGHT, LYING, ABSENT = "无法判断", "不满足", "倒地姿态", "检测不到"
TILT, HIP_HIGH = "躯干倾角不足", "髋部离地偏高"

# 各类原因的调整建议
ADVICE = {
    "看不到": "让全身（尤其膝、踝）留在画面内：摄像头抬高并向下俯，避免桌椅遮挡，人不要倒在画面下沿之外",
    TILT: "若这是蹲下、弯腰，不报正是预期；若是倒地：朝镜头或背对镜头倒下时，躯干在画面中被压短、看起来仍是竖的：改为侧向倒地（身体横在画面里），"
    "或把摄像头装到侧面、更高处",
    HIP_HIGH: "跪坐、半躺、靠墙坐倒时髋部离地仍高，二维骨骼无法判为倒地（已知局限）",
    ABSENT: "倒地后检测器丢失了此人：检查人在画面中是否过小、光线是否过暗、是否被遮挡",
    "中断": f"确认要求倒地后基本不动满 {CONFIRM_S:g} s：测试时倒地后静躺至少 {CONFIRM_S + 2:g} s",
    "未见倒下": f"没拍到倒下前站着的样子时按躺卧休息处理，确认要求不动满 {CONFIRM_UNSEEN_S:g} s："
    "测试时从站立开始拍，让倒下的过程完整入画",
    "在动": "倒地后挣扎、翻身或检测抖动使髋部移动超过一个躯干长度，不算倒地不动",
    "置信度": f"关键点置信度均值低于 {MIN_CONFIDENCE:g}：画面过暗、过小或模糊，检测不可靠",
}


@dataclass(frozen=True)
class Frame:
    t: float
    kind: str  # MISSING / UPRIGHT / LYING
    reason: str  # 分段依据：缺哪些部位、哪项不满足
    tilt: float | None = None
    hip: float | None = None
    score: float | None = None
    held: float | None = None  # 倒地计时（秒）
    mean: float | None = None  # 本次计时的置信度均值
    needed: float | None = None  # 确认所需的倒地时长
    still: bool | None = None
    seen_fall: bool | None = None


@dataclass
class Segment:
    kind: str
    reason: str
    frames: list[Frame]

    @property
    def start(self) -> float:
        return self.frames[0].t

    @property
    def end(self) -> float:
        return self.frames[-1].t


def describe(points: np.ndarray, scores: np.ndarray, falling: bool, fall, now: float) -> Frame:
    """一条轨迹本帧的判定说明；fall 为判定器更新后该轨迹的跌倒状态（vision_engine.behavior._Fall）。"""
    measure = fall_measure(points, scores)
    if measure is None:
        missing = [n for n, idx in PARTS if not any(scores[i] >= KEYPOINT_MIN for i in idx)]
        return Frame(now, MISSING, "看不到" + "、".join(missing) if missing else "躯干长度为 0")
    tilt_min, hip_max = fall_thresholds(falling)
    fails = []
    if measure.tilt_deg <= tilt_min:
        fails.append(f"{TILT}（需 >{tilt_min:g}°）")
    if measure.hip_ratio >= hip_max:
        fails.append(f"{HIP_HIGH}（需 <{hip_max:g} 倍躯干）")
    common = {"tilt": measure.tilt_deg, "hip": measure.hip_ratio, "score": measure.score}
    if fails:
        return Frame(now, UPRIGHT, "；".join(fails), **common)
    seen_fall = fall.lying - fall.upright <= TRANSITION_S
    return Frame(
        now,
        LYING,
        "",
        **common,
        held=now - fall.timer.start,
        mean=fall.timer.mean,
        needed=CONFIRM_S if seen_fall else CONFIRM_UNSEEN_S,
        still=fall._still(),
        seen_fall=seen_fall,
    )


def replay(data: dict[str, np.ndarray]) -> tuple[dict[int, list[Frame]], list[Behavior]]:
    """逐帧送入判定器（调用方式与检测链路、eval_behavior 相同），记下每条轨迹每帧的说明与发出的事件。"""
    detector = BehaviorDetector([])
    frames: dict[int, list[Frame]] = defaultdict(list)
    events: list[Behavior] = []
    for now in frame_times(data):
        at = data["t"] == now
        ids = data["track_id"][at]
        points = data["keypoints"][at].astype(float).reshape(-1, 17, 2)
        scores = data["keypoint_scores"][at].astype(float).reshape(-1, 17)
        # 本帧判定所用门限取决于更新前是否已发出跌倒事件（回差）
        tracks = detector._tracks  # 只读判定器内部状态，不另写判定
        falling = {int(i): int(i) in tracks and tracks[int(i)].fall.suspected for i in ids}
        events += detector.update(ids, points, scores, float(now), frame_size(data))
        for track_id, p, s in zip(ids, points, scores, strict=True):
            fall = detector._tracks[int(track_id)].fall
            frames[int(track_id)].append(describe(p, s, falling[int(track_id)], fall, float(now)))
    return dict(frames), events


def frame_times(data: dict[str, np.ndarray]) -> np.ndarray:
    """回放的帧时刻：录制时存了全部抽样帧（含没有人的帧）时用它，否则只有有轨迹的帧。"""
    return np.unique(data["frame_t"]) if "frame_t" in data else np.unique(data["t"])


def frame_size(data: dict[str, np.ndarray]) -> tuple[int, int] | None:
    """画面（宽, 高）；旧录制没有存，此时不判原地消失（判定器不知道最后位置是否贴边）。"""
    if "frame_size" not in data:
        return None
    width, height = (int(v) for v in data["frame_size"])
    return (width, height) if width > 0 and height > 0 else None


def segments(frames: list[Frame]) -> list[Segment]:
    """相邻且说明相同的帧合并为一段；轨迹中断超过 GAP_S 另记一段"检测不到"。"""
    result: list[Segment] = []
    for frame in frames:
        last = result[-1] if result else None
        if last is not None and frame.t - last.end > GAP_S:
            gap = [Frame(last.end, ABSENT, ""), Frame(frame.t, ABSENT, "")]
            result.append(Segment(ABSENT, "", gap))
            last = None
        if last is not None and (last.kind, last.reason) == (frame.kind, frame.reason):
            last.frames.append(frame)
        else:
            result.append(Segment(frame.kind, frame.reason, [frame]))
    return result


def _span(values: list[float | None], fmt: str) -> str:
    known = [v for v in values if v is not None]
    if not known:
        return "—"
    low, high = min(known), max(known)
    return fmt.format(low) if abs(high - low) < 1e-9 else f"{fmt.format(low)}–{fmt.format(high)}"


def render_segment(seg: Segment) -> str:
    head = f"  {seg.start:6.1f}–{seg.end:6.1f} s  {seg.kind:<4}"
    if seg.kind == ABSENT:
        return f"{head}  中断 {seg.end - seg.start:.1f} s（超过 {GAP_S:g} s 计时从头开始）"
    if seg.kind == MISSING:
        return f"{head}  {seg.reason}（关键点置信度 <{KEYPOINT_MIN:g}）"
    f = seg.frames
    numbers = (
        f"倾角 {_span([x.tilt for x in f], '{:.0f}')}°  髋高 {_span([x.hip for x in f], '{:.2f}')}"
        f"  置信 {_span([x.score for x in f], '{:.2f}')}"
    )
    if seg.kind == UPRIGHT:
        return f"{head}  {seg.reason}  {numbers}"
    last = f[-1]
    still = "不动" if last.still else "在动"
    return f"{head}  {numbers}  计时至 {last.held:.1f} s（确认需 {last.needed:g} s，末尾{still}）"


def conclude(frames: list[Frame], segs: list[Segment], events: list[Behavior]) -> list[str]:
    """结论与建议：先说结果，再说卡在哪一项。"""
    levels = {e.level for e in events}
    if "confirmed" in levels:
        return ["已确认跌倒，进入物理告警。"]
    lying = [f for f in frames if f.kind == LYING]
    advice: list[str] = []
    if "suspected" in levels:
        held = max(f.held or 0.0 for f in lying)
        needed = max(f.needed or 0.0 for f in lying)
        lines = [
            f"只发出疑似跌倒（只在告警栏提示），没有确认：倒地最长计时 {held:.1f} s，确认需 {needed:g} s。"
        ]
        if any(f.held is not None and f.held >= (f.needed or 0) and not f.still for f in lying):
            advice.append("在动")
        if held < needed:
            longest = max(
                (s for s in segs if s.kind == LYING), key=lambda s: s.frames[-1].held or 0
            )
            after = segs[segs.index(longest) + 1 :]
            if after:
                lines.append(
                    f"倒地计时在 {longest.end:.1f} s 后中断：随后{after[0].kind}{_why(after[0])}。"
                )
                advice.append(_key(after[0]))
            advice.append("中断")
        if needed == CONFIRM_UNSEEN_S:
            advice.append("未见倒下")
        return lines + [f"建议：{ADVICE[k]}。" for k in dict.fromkeys(advice) if k]
    if lying:
        held = max(f.held or 0.0 for f in lying)
        lines = [f"出现过倒地姿态，但最长只持续 {held:.1f} s，疑似需满 {MIN_DURATION_S:g} s。"]
        best = max(lying, key=lambda f: f.held or 0.0)
        if best.mean is not None and best.mean < MIN_CONFIDENCE:
            advice.append("置信度")
        after = [s for s in segs if s.kind != LYING and s.start >= best.t]
        if after:
            lines.append(f"随后{after[0].kind}{_why(after[0])}。")
            advice.append(_key(after[0]))
        return lines + [f"建议：{ADVICE[k]}。" for k in dict.fromkeys(advice) if k]
    return _never_lying(frames)


def _never_lying(frames: list[Frame]) -> list[str]:
    """从未满足倒地姿态：只看接近倒地（已越过退出门限之一）的帧找卡住的条件，站立、行走的帧不给跌倒建议。"""
    measured = [f for f in frames if f.kind == UPRIGHT]
    near = _near(frames)
    hidden = [f for f in frames if f.kind == MISSING]
    lines: list[str] = []
    advice: list[str] = []
    if seated := len(_low_hips(frames)) - len(near):
        lines.append(f"有 {seated} 帧躯干直立而髋部低（坐着或蹲着），不属于倒地。")
    if near:
        tilt = sum(TILT in f.reason for f in near)
        hip = sum(HIP_HIGH in f.reason for f in near)
        lines.append(
            f"从未满足倒地姿态。有 {len(near)} 帧接近倒地但未满足：{tilt} 帧{TILT}、{hip} 帧{HIP_HIGH}。"
        )
        advice += [k for k, n in sorted(((TILT, tilt), (HIP_HIGH, hip)), key=lambda x: -x[1]) if n]
    elif measured:
        top = max(f.tilt or 0 for f in measured)
        low = min(f.hip if f.hip is not None else 99 for f in measured)
        lines.append(
            f"全程没有接近倒地的姿态（站立、行走或坐着）：躯干倾角最大 {top:.0f}°，"
            f"髋部离地最低 {low:.2f} 倍躯干。如果这段里确实有人倒下，多半是朝镜头或背对镜头倒，"
            "躯干在画面中被压短。"
        )
    if hidden:
        share = len(hidden) * 100 // len(frames)
        lines.append(f"另有 {len(hidden)} 帧（{share}%）看不到肩、髋或腿，无法判断。")
        if share >= 20 or not measured:
            advice.insert(0, "看不到")
    return lines + [f"建议：{ADVICE[k]}。" for k in dict.fromkeys(advice)]


def _low_hips(frames: list[Frame]) -> list[Frame]:
    """未满足倒地姿态，但躯干倾角或髋部高度已越过退出门限（回差）之一。"""
    tilt_exit, hip_exit = fall_thresholds(True)
    return [
        f
        for f in frames
        if f.kind == UPRIGHT
        and ((f.tilt or 0) > tilt_exit or (f.hip if f.hip is not None else 99) < hip_exit)
    ]


def _near(frames: list[Frame]) -> list[Frame]:
    """接近倒地：越过退出门限之一，且躯干已不直立；躯干直立、只是髋部低的是坐着或蹲着。"""
    return [f for f in _low_hips(frames) if (f.tilt or 0) > STAND_TORSO_DEG]


def _quiet(frames: list[Frame], events: list[Behavior]) -> bool:
    """全程站立或行走：没有倒地姿态、没有接近倒地的帧、没有事件，看不清的帧不足 20%。默认只列编号。"""
    hidden = sum(f.kind == MISSING for f in frames)
    lying = any(f.kind == LYING for f in frames)
    return not events and not lying and not _near(frames) and hidden * 5 < len(frames)


def _why(seg: Segment) -> str:
    return f"（{seg.reason}）" if seg.reason else ""


def _key(seg: Segment) -> str:
    """分段原因归到 ADVICE 的类。"""
    if seg.kind == ABSENT:
        return ABSENT
    if seg.kind == MISSING:
        return "看不到"
    if seg.reason.startswith(TILT):
        return TILT
    if seg.reason.startswith(HIP_HIGH):
        return HIP_HIGH
    return ""


def report(
    data: dict[str, np.ndarray],
    track: int | None = None,
    detail: bool = False,
    everyone: bool = False,
) -> str:
    frames, events = replay(data)
    t = data["t"]
    duration = float(t.max() - t.min()) if len(t) else 0.0
    shown = {
        k: v for k, v in frames.items() if (track is None and len(v) >= MIN_FRAMES) or k == track
    }
    lines = [
        f"跌倒判定诊断：{duration:.1f} s，{len(np.unique(t))} 帧，轨迹 {len(frames)} 条"
        f"（列出 {len(shown)} 条，少于 {MIN_FRAMES} 帧的不列）",
        f"判定：肩、髋、腿可见，躯干倾角 >{fall_thresholds(False)[0]:g}°，髋部离地 <{fall_thresholds(False)[1]:g} 倍躯干；"
        f"满 {MIN_DURATION_S:g} s 疑似，倒地不动满 {CONFIRM_S:g} s 确认",
    ]
    if not shown:
        lines.append("没有可诊断的轨迹：画面中没有检测到人，或每条轨迹都太短。")
    falls = defaultdict(list)
    for e in events:
        if e.behavior == "fall":
            falls[e.track_id].append(e)
    quiet = [k for k, v in shown.items() if not everyone and k != track and _quiet(v, falls[k])]
    if quiet:
        listed = "、".join(map(str, sorted(quiet)))
        lines.append(f"轨迹 {listed} 全程站立、行走或坐着，没有接近倒地的姿态（加 --all 列出明细）")
    for track_id, track_frames in sorted(shown.items(), key=lambda kv: kv[1][0].t):
        if track_id in quiet:
            continue
        segs = segments(track_frames)
        own = falls[track_id]
        lines += [
            "",
            f"轨迹 {track_id}：{track_frames[0].t:.1f}–{track_frames[-1].t:.1f} s，{len(track_frames)} 帧",
        ]
        lines += [render_segment(s) for s in segs]
        if detail:
            lines += [f"    {f.t:6.2f} s {f.kind} {f.reason} {_numbers(f)}" for f in track_frames]
        # 轨迹已消失后才发出的疑似跌倒即原地消失；其余由倒地姿态计时发出
        vanished = [e for e in own if e.end > track_frames[-1].t]
        posture = [e for e in own if e not in vanished]
        if own:
            names = {"suspected": "疑似跌倒", "confirmed": "确认跌倒"}
            happened = "；".join(
                f"{e.end:.1f} s {names[e.level]}{'（原地消失）' if e in vanished else ''}"
                for e in own
            )
            lines.append(f"  事件：{happened}")
        if track_frames[0].kind == LYING:
            lines.append(
                "  注意：这条轨迹一出现就是倒地姿态，可能是检测器丢失此人后换了新编号，计时从头开始"
            )
        hidden = sum(f.kind == MISSING for f in track_frames)
        if hidden * 10 >= len(track_frames) * 3 and (where := placement(data, track_id)):
            lines.append(f"  位置：{where}")
        if vanished:
            lines.append(
                f"  {track_frames[-1].t:.1f} s 站着时在画面中间消失，{VANISH_S:g} s 内附近没有新轨迹："
                "按原地消失发出疑似跌倒（只在告警栏提示）。多是倒下后被遮挡、或检测器认不出横躺的人；"
                "要升为确认跌倒，须让倒地的人留在画面里被检测到"
            )
        if posture or not vanished:
            lines += [f"  {line}" for line in conclude(track_frames, segs, posture)]
    return "\n".join(lines)


EDGE = 0.05  # 关键点外框距画面边缘不足画面尺寸的此比例，视为贴边：身体可能有一部分在画面外
SMALL = 0.12  # 关键点外框高度不足画面高度的此比例，视为过小


def placement(data: dict[str, np.ndarray], track_id: int) -> str | None:
    """人在画面中的位置与大小（录制时存了画面尺寸才有）：解释"看不到"是贴边出画、人太小还是被遮挡。
    外框取置信度 ≥ 0.1 的关键点：低于看得见的门限，但能大致定位。"""
    if "frame_size" not in data:
        return None
    width, height = (float(v) for v in data["frame_size"])
    if width <= 0 or height <= 0:
        return None
    boxes = []
    for points, scores in zip(
        data["keypoints"][data["track_id"] == track_id].astype(float),
        data["keypoint_scores"][data["track_id"] == track_id].astype(float),
        strict=True,
    ):
        seen = points[scores >= 0.1]
        if len(seen) >= 2:
            boxes.append([*seen.min(axis=0), *seen.max(axis=0)])
    if not boxes:
        return "几乎没有可定位的关键点：人在画面外、被完全遮挡，或检测框里不是人"
    x0, y0, x1, y1 = np.median(np.array(boxes), axis=0)
    cx, cy = (x0 + x1) / 2 / width, (y0 + y1) / 2 / height
    side = "左" if cx < 1 / 3 else "右" if cx > 2 / 3 else "中"
    level = "上" if cy < 1 / 3 else "下" if cy > 2 / 3 else "中"
    if side == level == "中":
        area = "中央"
    elif side == "中":
        area = level + "部"
    elif level == "中":
        area = side + "侧"
    else:
        area = side + level + "角"
    text = f"多在画面{area}，"
    text += f"关键点外框高约 {y1 - y0:.0f} px（画面高的 {(y1 - y0) / height:.0%}）"
    edges = [
        name
        for name, gap in (
            ("左", x0 / width),
            ("右", 1 - x1 / width),
            ("上", y0 / height),
            ("下", 1 - y1 / height),
        )
        if gap < EDGE
    ]
    if edges:
        text += f"，贴着画面{'、'.join(edges)}沿：身体可能有一部分在画面外，把测试位置移到画面中间"
    elif (y1 - y0) / height < SMALL:
        text += "：人在画面中过小，关键点不可靠，靠近摄像头或换焦距"
    else:
        text += "：大小与位置都正常，看不到多半是被桌椅等遮挡"
    return text


def _numbers(f: Frame) -> str:
    if f.tilt is None:
        return ""
    text = f"倾角 {f.tilt:.0f}° 髋高 {f.hip:.2f} 置信 {f.score:.2f}"
    return text + (f" 计时 {f.held:.1f} s" if f.held is not None else "")


def record_video(source: str, output: Path, max_s: float | None = None) -> Path:
    """先录制为 .npz：与 record_keypoints 同一链路。未设模型环境变量时取 compose 中视觉引擎所用的文件
    （视觉引擎容器内已设，不读 compose）。"""
    names = ("HYD_MODEL_FILE", "HYD_VEHICLE_MODEL_FILE")
    if not all(name in os.environ for name in names):
        compose = yaml.safe_load((ROOT / "deploy/compose/compose.yaml").read_text(encoding="utf-8"))
        env = compose["services"]["vision-engine"]["environment"]
        for name in names:
            os.environ.setdefault(name, str(ROOT / "models/weights" / Path(env[name]).name))
    os.environ.setdefault("HYD_DEVICE", "cpu")
    spec = importlib.util.spec_from_file_location(
        "record_keypoints", Path(__file__).with_name("record_keypoints.py")
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.record(source, str(output), max_s)
    return output


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("source", help="录制的 .npz、视频文件（先录制为同名 .npz）或 RTSP 地址")
    parser.add_argument("--seconds", type=float, default=60.0, help="RTSP 地址时录制的秒数")
    parser.add_argument("--save", type=Path, default=Path("live.npz"), help="RTSP 录制的保存位置")
    parser.add_argument("--track", type=int, help="只看这条轨迹（短轨迹也列出）")
    parser.add_argument("--detail", action="store_true", help="另列每一帧的几何量")
    parser.add_argument("--all", action="store_true", help="全程站立、行走的轨迹也列出明细")
    args = parser.parse_args()
    if args.source.startswith("rtsp://"):
        path = record_video(args.source, args.save, args.seconds)
    elif args.source.endswith(".npz"):
        path = Path(args.source)
    else:
        path = record_video(args.source, Path(args.source).with_suffix(".npz"))
    with np.load(path) as loaded:
        data = {k: loaded[k] for k in loaded.files}
    print(report(data, args.track, args.detail, args.all))
    return 0


if __name__ == "__main__":
    sys.exit(main())
