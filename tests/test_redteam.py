"""tools/dev/redteam.py：画面篡改（重放切回原始节目约 45 秒前，恢复切回转发原始节目，不靠推算进度跳转）
与攻击命令（attack-sim 的启动参数与退出码）。不启动容器。"""

import importlib.util
import subprocess
import sys
from pathlib import Path

import pytest
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


class FakeCompose:
    def __init__(self, returncode: int, stdout: str) -> None:
        self.res = subprocess.CompletedProcess(["docker"], returncode, stdout)

    def call(self, *args: str) -> subprocess.CompletedProcess[str]:
        self.args = args
        return self.res


def test_attack_blocked_by_firewall_still_succeeds(capsys: pytest.CaptureFixture[str]) -> None:
    """尝试全部连接失败（已被封禁）也是攻击跑完：命令成功，输出照常显示。"""
    out = "rtsp-bruteforce: 0/6 denied by rtsp://rtsp-target:8554/cam\n"
    assert redteam.attack(FakeCompose(0, out), slow=False) == 0
    assert "0/6 denied" in capsys.readouterr().out


def test_attack_container_not_started_fails(capsys: pytest.CaptureFixture[str]) -> None:
    """attack-sim 没能运行（如镜像未构建）时命令失败，提示没有发出攻击流量。"""
    assert redteam.attack(FakeCompose(1, "no such service\n"), slow=False) == 1
    assert "没有发出攻击流量" in capsys.readouterr().err


def test_hijack_runs_announce_script_with_registered_params() -> None:
    """推流劫持改用镜像内的 rtsp-hijack，次数与间隔取自 demo/scenarios/attack-sim.yaml；爆破不带这些参数。"""
    compose = FakeCompose(0, "rtsp-hijack: 3/3 refused by rtsp://rtsp-target:8554/cam\n")
    assert redteam.attack(compose, hijack=True) == 0
    args = list(compose.args)
    assert args[args.index("--entrypoint") + 1] == "rtsp-hijack" and args[-1] == "attack-sim"
    assert {"HYD_HIJACK_ATTEMPTS=3", "HYD_HIJACK_INTERVAL_S=2"} <= set(args)

    redteam.attack(compose)
    assert "--entrypoint" not in compose.args
