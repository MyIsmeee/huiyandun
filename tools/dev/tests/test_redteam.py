"""红方手动命令（D-105）：原时间线进度与推流命令。不启动容器。"""

import importlib.util
import subprocess
import sys
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "redteam.py"
_spec = importlib.util.spec_from_file_location("redteam", SCRIPT)
assert _spec is not None and _spec.loader is not None
redteam = importlib.util.module_from_spec(_spec)
sys.modules["redteam"] = redteam
_spec.loader.exec_module(redteam)


def test_position_follows_original_timeline_and_loops() -> None:
    """篡改期间原时间线照常前进；素材循环播放。"""
    state = {"base": 100.0, "since": 1000.0}
    assert redteam.position(state, 1050.0, 600.0) == pytest.approx(150.0)
    assert redteam.position(state, 1600.0, 600.0) == pytest.approx(100.0)


def test_replay_starts_two_minutes_back_and_wraps() -> None:
    """重放取约 2 分钟前（FR-302 的 30～180 s 内）；开头 2 分钟内回绕到素材末尾。"""
    assert "-ss 180 " in redteam.source_for("replay", "cam-02", 300.0, 600.0)
    assert "-ss 540 " in redteam.source_for("replay", "cam-02", 60.0, 600.0)


def test_restore_continues_and_freeze_uses_still_frame() -> None:
    assert "-ss 300 " in redteam.source_for("restore", "cam-02", 300.0, 600.0)
    freeze = redteam.source_for("freeze", "cam-02", 300.0, 600.0)
    assert "/tmp/freeze-cam-02.png" in freeze and "keyint=1" in freeze


class FakeCompose:
    def __init__(self, returncode: int, stdout: str) -> None:
        self.res = subprocess.CompletedProcess(["docker"], returncode, stdout)

    def call(self, *args: str) -> subprocess.CompletedProcess[str]:
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
