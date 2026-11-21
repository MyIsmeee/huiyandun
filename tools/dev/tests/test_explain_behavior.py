"""跌倒判定的逐帧诊断（TK-160）：结论与线上判定一致，并指出卡住的条件。"""

import importlib.util
from pathlib import Path
from types import ModuleType

import numpy as np

DEV = Path(__file__).resolve().parents[1]
CLIPS = DEV.parents[1] / "services/vision-engine/tests/clips"


def load(name: str) -> ModuleType:
    spec = importlib.util.spec_from_file_location(name, DEV / f"{name}.py")
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


ex, ev = load("explain_behavior"), load("eval_behavior")


def clip(name: str) -> dict[str, np.ndarray]:
    with np.load(CLIPS / f"{name}.npz") as loaded:
        return {k: loaded[k] for k in loaded.files}


def test_events_match_detection_chain() -> None:
    """诊断只读判定器状态、不另写判定：发出的事件与评测回放（同检测链路）逐条相同。"""
    data = clip("fall-2")
    _, events = ex.replay(data)
    assert events == ev.replay(data, [])


def test_confirmed_fall_and_bystanders_collapsed() -> None:
    text = ex.report(clip("fall-2"))
    assert "事件：5.8 s 疑似跌倒；11.8 s 确认跌倒" in text
    assert "已确认跌倒，进入物理告警。" in text
    # 全程站立的路人只列编号，不给跌倒建议
    assert "轨迹 1、3、5、6、7 全程站立、行走或坐着" in text
    assert "轨迹 1：" not in text


def test_suspected_but_lost_after_lying_explained() -> None:
    """fall-1：倒地 6.2 s 后检测器丢失此人，计时中断，只到疑似。"""
    text = ex.report(clip("fall-1"), track=0)
    assert "倒地最长计时 6.2 s，确认需 8 s" in text
    assert "倒地计时在 16.0 s 后中断：随后检测不到" in text
    assert "倒地后检测器丢失了此人" in text
    assert "测试时倒地后静躺至少 10 s" in text


def test_missing_legs_reported_per_frame() -> None:
    """腿（膝、踝）都不可见时这一帧无法判断，并写明缺哪个部位。"""
    points = np.zeros((17, 2))
    points[[5, 6], 1], points[[11, 12], 1] = 100.0, 200.0  # 肩在上、髋在下：直立
    scores = np.full(17, 0.9)
    scores[list(range(13, 17))] = 0.1
    frame = ex.describe(points, scores, False, None, 0.0)  # 无法判断时不读跌倒状态
    assert (frame.kind, frame.reason) == (ex.MISSING, "看不到腿")


def test_upright_frame_names_failed_condition() -> None:
    points = np.zeros((17, 2))
    points[[5, 6]] = [[100.0, 100.0], [110.0, 100.0]]
    points[[11, 12]] = [[100.0, 200.0], [110.0, 200.0]]
    points[[13, 14]] = [[100.0, 280.0], [110.0, 280.0]]
    points[[15, 16]] = [[100.0, 360.0], [110.0, 360.0]]
    frame = ex.describe(points, np.full(17, 0.9), False, None, 0.0)
    assert frame.kind == ex.UPRIGHT
    assert frame.reason == "躯干倾角不足（需 >60°）；髋部离地偏高（需 <0.5 倍躯干）"
    assert round(frame.tilt) == 0 and round(frame.hip, 2) == 1.6


def test_placement_explains_edge_and_size() -> None:
    """录制时存了画面尺寸：说明人贴着画面哪条边、在画面中多大，区分出画、过小与遮挡。"""
    edge = np.zeros((17, 2))
    edge[:, 0], edge[:, 1] = np.linspace(40, 100, 17), np.linspace(1000, 1075, 17)
    center = np.zeros((17, 2))
    center[:, 0], center[:, 1] = np.linspace(900, 1000, 17), np.linspace(300, 700, 17)
    data = {
        "t": np.array([0.0, 0.0]),
        "track_id": np.array([1, 2]),
        "keypoints": np.stack([edge, center]),
        "keypoint_scores": np.full((2, 17), 0.2),
        "frame_size": np.array([1920, 1080]),
    }
    assert ex.placement(data, 1).startswith(
        "多在画面左下角，关键点外框高约 75 px（画面高的 7%），贴着画面左、下沿"
    )
    assert ex.placement(data, 2).endswith("大小与位置都正常，看不到多半是被桌椅等遮挡")
    assert ex.placement({k: v for k, v in data.items() if k != "frame_size"}, 1) is None


def test_vanish_reported_with_reason() -> None:
    """录制存了全部帧时刻与画面尺寸：站着的人在画面中间消失，报告写明按原地消失发出疑似跌倒。"""
    stand = np.zeros((17, 2))
    stand[:] = [900.0, 500.0]
    stand[[5, 6]] = [[890.0, 400.0], [910.0, 400.0]]
    stand[[11, 12]] = [[892.0, 500.0], [908.0, 500.0]]
    stand[[13, 14]] = [[900.0, 580.0], [900.0, 580.0]]
    stand[[15, 16]] = [[900.0, 660.0], [900.0, 660.0]]
    seen = np.arange(0, 5, 0.2)
    data = {
        "t": seen,
        "track_id": np.zeros(len(seen), int),
        "keypoints": np.repeat(stand[None], len(seen), axis=0),
        "keypoint_scores": np.full((len(seen), 17), 0.9),
        "frame_t": np.arange(0, 10, 0.2),
        "frame_size": np.array([1920, 1080]),
    }
    text = ex.report(data, track=0)
    assert "事件：7.8 s 疑似跌倒（原地消失）" in text
    assert "4.8 s 站着时在画面中间消失" in text
    # 旧录制没有全部帧时刻与画面尺寸：不判原地消失
    old = {k: v for k, v in data.items() if k not in ("frame_t", "frame_size")}
    assert "原地消失" not in ex.report(old, track=0)
