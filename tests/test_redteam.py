"""tools/dev/redteam.py 的画面篡改：重放切回原始节目约 45 秒前，恢复切回转发原始节目（不靠推算进度跳转）。"""

import importlib.util
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location("redteam", ROOT / "tools/dev/redteam.py")
assert _spec and _spec.loader
redteam = importlib.util.module_from_spec(_spec)
sys.modules["redteam"] = redteam
_spec.loader.exec_module(redteam)

DURATION = 578.0


def test_program_position_loops_from_stream_start() -> None:
    assert redteam.program_position(1122.0, 1000.0, DURATION) == 122.0
    assert redteam.program_position(1000.0 + DURATION + 30, 1000.0, DURATION) == 30.0


def test_replay_plays_file_from_back_of_program_position() -> None:
    config = redteam.path_config("replay", "cam-02", 209.0, DURATION)
    assert config["source"] == "publisher"
    assert f"-ss {209 - redteam.REPLAY_BACK_S} " in str(config["runOnInit"])
    assert "/media/cam-02.mp4" in str(config["runOnInit"])
    # 回绕：进度不足回退秒数时从素材末尾取
    wrapped = redteam.path_config("replay", "cam-02", 10.0, DURATION)
    assert f"-ss {DURATION + 10 - redteam.REPLAY_BACK_S:.0f} " in str(wrapped["runOnInit"])


def test_replay_back_within_fr302_window() -> None:
    assert 30 <= redteam.REPLAY_BACK_S <= 180


def test_restore_relays_untouched_program() -> None:
    assert redteam.path_config("restore", "cam-02", 209.0, DURATION) == {
        "source": "rtsp://127.0.0.1:8554/src-cam-02",
        "runOnInit": "",
    }


def test_mediamtx_programs_never_seek_and_cameras_relay_them() -> None:
    """原始节目从第 0 秒循环、不带 -ss；对外的摄像头路径转发对应的原始节目。"""
    paths = yaml.safe_load((ROOT / "deploy/compose/mediamtx.yml").read_text(encoding="utf-8"))[
        "paths"
    ]
    for camera in ("cam-01", "cam-02"):
        program = paths[f"src-{camera}"]["runOnInit"]
        assert (
            f"/media/{camera}.mp4" in program
            and "-ss" not in program
            and "-stream_loop -1" in program
        )
        assert paths[camera]["source"] == f"rtsp://127.0.0.1:8554/src-{camera}"
