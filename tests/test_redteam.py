"""tools/dev/redteam.py 的画面篡改时间线：重放须切回识别引擎看过的片段。"""

import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location("redteam", ROOT / "tools/dev/redteam.py")
assert _spec and _spec.loader
redteam = importlib.util.module_from_spec(_spec)
sys.modules["redteam"] = redteam
_spec.loader.exec_module(redteam)

DURATION = 578.0
STARTED = 1000.0  # mediamtx 启动时刻，路径同时开始从素材第 0 秒推流


def test_first_tamper_counts_from_stream_start() -> None:
    state = redteam.timeline(None, now=1122.0, ready=STARTED, mediamtx_started=STARTED)
    assert redteam.position(state, 1122.0, DURATION) == 122.0


def test_timeline_survives_restore() -> None:
    """恢复后推流从第 145 秒续播、推流时刻变为 1145；再次篡改仍按原时间线，不把 1145 当作第 0 秒。"""
    first = redteam.timeline(None, now=1122.0, ready=STARTED, mediamtx_started=STARTED)
    # 恢复：source_for("restore") 从原时间线位置续播
    assert redteam.position(first, 1145.0, DURATION) == 145.0
    # 64 s 后再次重放：路径的 readyTime 已是恢复时刻 1145
    again = redteam.timeline(first, now=1209.0, ready=1145.0, mediamtx_started=STARTED)
    assert redteam.position(again, 1209.0, DURATION) == 209.0
    assert redteam.source_for("replay", "cam-02", 209.0, DURATION).count("-ss 89 ") == 1


def test_mediamtx_restart_starts_new_timeline() -> None:
    old = redteam.timeline(None, now=1122.0, ready=STARTED, mediamtx_started=STARTED)
    restarted = 2000.0
    state = redteam.timeline(old, now=2030.0, ready=restarted, mediamtx_started=restarted)
    assert redteam.position(state, 2030.0, DURATION) == 30.0
