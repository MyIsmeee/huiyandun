"""行为判定事件级评测（TK-160）：比对口径、误报率上界，以及素材片段的当前结果。"""

import importlib.util
import json
from pathlib import Path

import pytest

from vision_engine.behavior import Behavior

SCRIPT = Path(__file__).resolve().parents[1] / "eval_behavior.py"
_spec = importlib.util.spec_from_file_location("eval_behavior", SCRIPT)
assert _spec and _spec.loader
ev = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ev)


def labels(*events: tuple[str, float, float], ambiguous=(), report_only=False) -> object:
    return ev.Labels([ev.Event(*e) for e in events], list(ambiguous), [], report_only)


def alert(at: float, behavior: str = "fall", track: int = 1, level: str = "suspected") -> Behavior:
    if behavior == "climb":
        level = "confirmed"
    return Behavior(track, behavior, 0.9, at - 2.0, at, level)  # 告警时刻为 end


def verdicts(result) -> list[str]:
    return [a["verdict"] for a in result.alerts]


def test_detected_within_window_with_latency() -> None:
    result = ev.judge("c", 60, labels(("fall", 10, 30)), [alert(14.5)])

    suspected, confirmed = result.detected
    assert suspected["detected"] and suspected["latency_s"] == pytest.approx(4.5)
    assert not confirmed["detected"]
    assert verdicts(result) == ["matched"]


def test_levels_scored_separately_with_own_windows() -> None:
    """疑似与确认各算检出；确认的检出窗口为 20 s（要等倒地不动满 8 s）。"""
    alerts = [alert(12), alert(26, level="confirmed")]
    result = ev.judge("c", 60, labels(("fall", 10, 40)), alerts)

    assert [(d["level"], d["detected"], d["latency_s"]) for d in result.detected] == [
        ("suspected", True, pytest.approx(2)),
        ("confirmed", True, pytest.approx(16)),
    ]
    late = ev.judge("c", 60, labels(("fall", 10, 40)), [alert(31, level="confirmed")])
    assert not late.detected[1]["detected"]


def test_false_alarms_counted_per_level() -> None:
    alerts = [alert(10), alert(12, level="confirmed")]  # 同一时刻的疑似与确认不互相合并
    result = ev.judge("c", 60, labels(), alerts)

    assert verdicts(result) == ["false_alarm", "false_alarm"]
    summary = ev.summarize([result])
    assert summary["fall/suspected"]["false_alarms"] == 1
    assert summary["fall/confirmed"]["false_alarms"] == 1


def test_late_alert_is_miss_but_not_false_alarm() -> None:
    # 真值开始 10 s 之后才告警：漏检；但仍在真值持续期内，不另算误报
    result = ev.judge("c", 60, labels(("fall", 10, 30)), [alert(25)])

    assert not result.detected[0]["detected"]
    assert verdicts(result) == ["matched"]


def test_alert_before_tolerance_is_false_alarm() -> None:
    result = ev.judge("c", 60, labels(("fall", 10, 30)), [alert(7.9)])

    assert not result.detected[0]["detected"]
    assert verdicts(result) == ["false_alarm"]


def test_other_behavior_does_not_match() -> None:
    result = ev.judge("c", 60, labels(("fall", 10, 30)), [alert(12, "climb")])

    assert not result.detected[0]["detected"]
    assert verdicts(result) == ["false_alarm"]


def test_repeats_during_event_are_not_false_alarms() -> None:
    # 倒地 60 s：检测器每 30 s 重发，均属同一真值
    result = ev.judge("c", 120, labels(("fall", 10, 70)), [alert(12), alert(42), alert(72)])

    assert verdicts(result) == ["matched"] * 3


def test_false_alarms_merged_within_window() -> None:
    alerts = [alert(10), alert(12, track=2), alert(16), alert(40)]
    result = ev.judge("c", 60, labels(), alerts)

    assert verdicts(result) == ["false_alarm", "merged", "false_alarm", "false_alarm"]


def test_ambiguous_and_report_only_are_ignored() -> None:
    result = ev.judge("c", 60, labels(ambiguous=[(20, 30)]), [alert(25), alert(50)])
    assert verdicts(result) == ["ignored", "false_alarm"]

    result = ev.judge("c", 60, labels(report_only=True), [alert(25)])
    assert verdicts(result) == ["ignored"]


def test_summary_rates_and_exposure() -> None:
    # 攀爬只在配置了警戒线的片段上计暴露时长
    with_line = ev.judge("a", 1800, ev.Labels([], [], [[0, 0, 1, 1]], False), [alert(100)])
    no_line = ev.judge("b", 1800, labels(("fall", 10, 20)), [alert(12)])
    skipped = ev.judge("c", 3600, labels(report_only=True), [alert(5)])

    summary = ev.summarize([with_line, no_line, skipped])

    fall = summary["fall/suspected"]
    assert fall["recall"] == 1.0
    assert fall["false_alarms"] == 1
    assert fall["exposure_hours"] == pytest.approx(1.0)
    assert fall["fa_per_hour"] == pytest.approx(1.0)
    assert summary["fall/confirmed"]["recall"] == 0.0
    assert summary["climb/confirmed"]["recall"] is None
    assert summary["climb/confirmed"]["exposure_hours"] == pytest.approx(0.5)


@pytest.mark.parametrize(("count", "upper"), [(0, 2.996), (1, 4.744), (5, 10.513)])
def test_poisson_upper_matches_exact_bound(count: int, upper: float) -> None:
    """单侧 95% 上界（卡方分布表值）：零次时即"三分法"的约 3。"""
    assert ev.poisson_upper(count) == pytest.approx(upper, abs=1e-3)


def test_percentile_nearest_rank() -> None:
    assert ev.percentile([], 50) is None
    assert ev.percentile([3.0, 1.0, 2.0], 50) == 2.0
    assert ev.percentile([1.0, 2.0, 3.0, 4.0, 10.0], 90) == 10.0


def test_invalid_label_rejected(tmp_path: Path) -> None:
    path = tmp_path / "x.json"
    path.write_text(json.dumps({"events": [{"behavior": "run", "start": 1, "end": 2}]}))

    with pytest.raises(ValueError, match="标注有误"):
        ev.load_labels(path)


def test_recorded_clips_all_labeled_and_current_results() -> None:
    """素材片段都有标注；当前判定在计分片段上全部检出、零误报（规则或检测器变化后若回退即失败）。
    样本量很小，这只是回归门槛，不代表准确率：见报告中的误报率 95% 上界。"""
    results, skipped = ev.evaluate(ev.CLIPS)

    assert skipped == []
    summary = ev.summarize(results)
    for kind, s in summary.items():
        # 长时间静止与疑似打架还没有带真值的素材，只要求零误报；有了素材后同样要求全部检出
        assert s["recall"] in ((1.0, None) if s["events"] == 0 else (1.0,)), (kind, s)
        assert s["false_alarms"] == 0, (kind, s)
    assert all(
        summary[k]["events"] > 0 for k in ("fall/suspected", "fall/confirmed", "climb/confirmed")
    )
