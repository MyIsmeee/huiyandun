"""行为判定的事件级评测（TK-160）：回放录制的骨骼轨迹，按标注统计召回、误报与检出延迟。

用法：uv run --all-packages python tools/dev/eval_behavior.py [片段目录] [--json 报告.json]
片段目录默认 services/vision-engine/tests/clips。每段 <名>.npz（tools/dev/record_keypoints.py 录制）
配一份同名标注 <名>.json，格式见 load_labels；没有标注的片段跳过并提示。

口径（参照 i-LIDS 与 NIST ActEV 的事件级评测，不用帧级指标）：
- 告警时刻取事件发出的时刻（Behavior.end）；Behavior.start 是回溯的计时起点，不代表何时告警
- 按"行为 + 级别"分别计分：跌倒的疑似（只在控制台提示）与确认（进入物理告警）各算一套指标，攀爬只有确认
- 检出：同类告警在 [真值开始 − PRE_S, 真值开始 + POST_S[类]] 内发出即检出该真值；延迟 = 首个告警 − 真值开始。
  确认按设计要等倒地不动满 8 s，检出窗口放宽到 20 s
- 不计误报：落在同行为真值 [开始 − PRE_S, 结束 + POST_S[类]] 内的告警（含持续期间的重发与重复），
  以及落在 ambiguous 时段或 report_only 片段中的告警
- 误报：其余告警；同类误报在 FA_MERGE_S 内只计一次
- 误报率按"路·小时"计：攀爬只在配置了警戒线的片段上可能告警，暴露时长只计这些片段。附泊松单侧 95% 上界：
  零误报时约为 3 / 暴露时长，样本少时上界很宽，据此判断还缺多少常态画面
"""

import argparse
import json
import math
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

import numpy as np

from vision_engine.behavior import Behavior, BehaviorDetector

ROOT = Path(__file__).resolve().parents[2]
CLIPS = ROOT / "services/vision-engine/tests/clips"
BEHAVIORS = ("fall", "climb", "still", "fight")
# 计分的类：（行为, 级别）→ 真值开始后此时长内须告警，晚于此即漏检（i-LIDS 的 10 s 检出窗口；
# 确认跌倒要求倒地不动满 8 s，放宽到 20 s）
POST_S: dict[tuple[str, str], float] = {
    ("fall", "suspected"): 10.0,
    ("fall", "confirmed"): 20.0,
    ("climb", "confirmed"): 10.0,
    # 长时间静止的真值起点即开始不动的时刻：门限 120 s、300 s 之后再留 10 s
    ("still", "suspected"): 130.0,
    ("still", "confirmed"): 310.0,
    ("fight", "suspected"): 10.0,
}
KINDS = tuple(POST_S)
PRE_S = 2.0  # 早于真值开始此时长内的告警仍算检出（真值起点的人工标注误差）
FA_MERGE_S = 5.0  # 同类误报在此时长内合并为一次
CONFIDENCE = 0.95  # 误报率上界的单侧置信水平


@dataclass(frozen=True)
class Event:
    behavior: str
    start: float
    end: float


@dataclass
class Labels:
    events: list[Event]
    ambiguous: list[tuple[float, float]]
    climb_lines: list[list[float]]
    report_only: bool


@dataclass
class ClipResult:
    name: str
    duration_s: float
    report_only: bool
    climb_lines: int
    alerts: list[dict[str, Any]] = field(default_factory=list)  # 每条告警及其判定
    detected: list[dict[str, Any]] = field(default_factory=list)  # 每个真值是否检出与延迟


def load_labels(path: Path) -> Labels:
    """标注格式：
    {
      "report_only": false,              # true：整段只报告、不计入指标（如二维骨骼无法判定）
      "climb_lines": [[u1, v1, u2, v2]], # 该画面的攀爬警戒线（像素）
      "events":    [{"behavior": "fall", "start": 3.0, "end": 20.0}],
      "ambiguous": [{"start": 40.0, "end": 55.0}],  # 无法判定的时段：不算漏检也不算误报
      "source": "..."                    # 标注依据，如"对照原视频逐帧核对"
    }
    时间为录制数据中 t 的秒数（与 npz 同一时间轴）。"""
    raw = json.loads(path.read_text(encoding="utf-8"))
    events = [
        Event(e["behavior"], float(e["start"]), float(e["end"])) for e in raw.get("events", [])
    ]
    for event in events:
        if event.behavior not in BEHAVIORS or event.end < event.start:
            raise ValueError(f"{path.name}：标注有误 {event}")
    ambiguous = [(float(a["start"]), float(a["end"])) for a in raw.get("ambiguous", [])]
    return Labels(events, ambiguous, raw.get("climb_lines", []), bool(raw.get("report_only")))


def replay(data: dict[str, np.ndarray], climb_lines: list[list[float]]) -> list[Behavior]:
    """按录制时刻逐帧送入判定器，与检测链路的调用方式相同。"""
    detector = BehaviorDetector(climb_lines)
    found: list[Behavior] = []
    for now in np.unique(data["t"]):
        at = data["t"] == now
        found += detector.update(
            data["track_id"][at],
            data["keypoints"][at].astype(float),
            data["keypoint_scores"][at].astype(float),
            float(now),
        )
    return found


def score_clip(name: str, data: dict[str, np.ndarray], labels: Labels) -> ClipResult:
    t = data["t"]
    duration = float(t.max() - t.min()) if len(t) else 0.0
    return judge(name, duration, labels, replay(data, labels.climb_lines))


def judge(name: str, duration: float, labels: Labels, alerts: list[Behavior]) -> ClipResult:
    """按模块说明的口径比对告警与标注。"""
    result = ClipResult(name, duration, labels.report_only, len(labels.climb_lines))
    for event in labels.events:
        for behavior, level in KINDS:
            if behavior != event.behavior:
                continue
            post = POST_S[behavior, level]
            hits = [a.end for a in alerts if (a.behavior, a.level) == (behavior, level)
                    and event.start - PRE_S <= a.end <= event.start + post]  # fmt: skip
            latency = min(hits) - event.start if hits else None
            result.detected.append(
                {**asdict(event), "level": level, "detected": bool(hits), "latency_s": latency}
            )
    last_fa: dict[tuple[str, str], float] = {}
    for alert in sorted(alerts, key=lambda a: a.end):
        kind = (alert.behavior, alert.level)
        post = POST_S[kind]
        verdict = "false_alarm"
        if labels.report_only or any(lo <= alert.end <= hi for lo, hi in labels.ambiguous):
            verdict = "ignored"
        elif any(e.behavior == alert.behavior and e.start - PRE_S <= alert.end <= e.end + post
                 for e in labels.events):  # fmt: skip
            verdict = "matched"
        elif alert.end - last_fa.get(kind, -math.inf) < FA_MERGE_S:
            verdict = "merged"  # 与上一条同类误报合并
        if verdict == "false_alarm":
            last_fa[kind] = alert.end
        result.alerts.append({
            "behavior": alert.behavior, "level": alert.level, "track_id": alert.track_id,
            "at": round(alert.end, 2), "confidence": round(alert.confidence_avg, 3),
            "verdict": verdict,
        })  # fmt: skip
    return result


def poisson_upper(count: int, confidence: float = CONFIDENCE) -> float:
    """泊松均值的单侧上界：使 P(X ≤ count) = 1 − confidence 的 λ（二分求解，不依赖 scipy）。"""

    def cdf(lam: float) -> float:
        term = total = math.exp(-lam)
        for k in range(1, count + 1):
            term *= lam / k
            total += term
        return total

    lo, hi = 0.0, max(10.0, 10.0 * (count + 1))
    for _ in range(200):
        mid = (lo + hi) / 2
        lo, hi = (mid, hi) if cdf(mid) > 1 - confidence else (lo, mid)
    return hi


def percentile(values: list[float], q: float) -> float | None:
    """最近秩百分位；样本少时不插值，避免报出没有出现过的延迟。"""
    if not values:
        return None
    ordered = sorted(values)
    return ordered[max(0, math.ceil(q / 100 * len(ordered)) - 1)]


def _kind(item: dict[str, Any]) -> tuple[str, str]:
    return item["behavior"], item["level"]


def summarize(results: list[ClipResult]) -> dict[str, Any]:
    scored = [r for r in results if not r.report_only]
    summary: dict[str, Any] = {}
    for kind in KINDS:
        behavior, level = kind
        truths = [d for r in scored for d in r.detected if _kind(d) == kind]
        latencies = [d["latency_s"] for d in truths if d["detected"]]
        exposed = [r for r in scored if behavior != "climb" or r.climb_lines]
        hours = sum(r.duration_s for r in exposed) / 3600
        fas = sum(
            a["verdict"] == "false_alarm" and _kind(a) == kind for r in scored for a in r.alerts
        )
        summary[f"{behavior}/{level}"] = {
            "events": len(truths),
            "detected": len(latencies),
            "recall": len(latencies) / len(truths) if truths else None,
            "latency_median_s": percentile(latencies, 50),
            "latency_p90_s": percentile(latencies, 90),
            "false_alarms": fas,
            "exposure_hours": hours,
            "fa_per_hour": fas / hours if hours else None,
            "fa_per_hour_upper95": poisson_upper(fas) / hours if hours else None,
        }
    return summary


def evaluate(directory: Path) -> tuple[list[ClipResult], list[str]]:
    results, skipped = [], []
    for npz in sorted(directory.glob("*.npz")):
        label_file = npz.with_suffix(".json")
        if not label_file.exists():
            skipped.append(npz.stem)
            continue
        with np.load(npz) as archive:
            data = {k: archive[k] for k in archive.files}
        results.append(score_clip(npz.stem, data, load_labels(label_file)))
    return results, skipped


def _fmt(value: float | None, digits: int = 1, suffix: str = "") -> str:
    return "—" if value is None else f"{value:.{digits}f}{suffix}"


def render(results: list[ClipResult], skipped: list[str], summary: dict[str, Any]) -> str:
    titles = {
        "fall/suspected": "跌倒·疑似",
        "fall/confirmed": "跌倒·确认",
        "climb/confirmed": "攀爬",
    }
    lines = ["行为判定事件级评测", ""]
    for b, s in summary.items():
        recall = (
            "—" if s["recall"] is None else f"{s['detected']}/{s['events']}（{s['recall']:.0%}）"
        )
        lines += [
            f"[{titles[b]}] 召回 {recall}  延迟 中位 {_fmt(s['latency_median_s'], 1, ' s')}"
            f" / P90 {_fmt(s['latency_p90_s'], 1, ' s')}",
            f"  误报 {s['false_alarms']} 次 / {s['exposure_hours'] * 60:.1f} 路·分钟"
            f"  → {_fmt(s['fa_per_hour'], 2)} 次/路·小时（95% 上界 {_fmt(s['fa_per_hour_upper95'], 1)}）",
        ]
    lines += ["", "逐段："]
    for r in results:
        tag = "（只报告）" if r.report_only else ""
        lines.append(f"- {r.name}{tag} {r.duration_s:.0f} s")
        for d in r.detected:
            got = f"检出，延迟 {d['latency_s']:.1f} s" if d["detected"] else "漏检"
            lines.append(
                f"    真值 {titles['/'.join(_kind(d))]} {d['start']:g}–{d['end']:g} s：{got}"
            )
        for a in r.alerts:
            lines.append(
                f"    告警 {titles['/'.join(_kind(a))]} @ {a['at']:g} s"
                f" 轨迹 {a['track_id']}"
                f" 置信 {a['confidence']:.2f}：{a['verdict']}"
            )
    if skipped:
        lines += ["", f"无标注、已跳过：{'、'.join(skipped)}"]
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("clips", nargs="?", type=Path, default=CLIPS)
    parser.add_argument("--json", type=Path, help="另存机器可读的报告")
    args = parser.parse_args()
    results, skipped = evaluate(args.clips)
    if not results:
        print(f"{args.clips} 中没有带标注的片段", file=sys.stderr)
        return 1
    summary = summarize(results)
    print(render(results, skipped, summary))
    if args.json:
        report = {
            "protocol": {"pre_s": PRE_S, "fa_merge_s": FA_MERGE_S, "confidence": CONFIDENCE,
                         "post_s": {f"{b}/{lv}": s for (b, lv), s in POST_S.items()}},
            "summary": summary,
            "clips": [asdict(r) for r in results],
            "skipped": skipped,
        }  # fmt: skip
        args.json.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
