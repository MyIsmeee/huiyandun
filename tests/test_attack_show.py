"""tools/dev/attack_show.py：录屏演示的攻击输出解析与参数。"""

import importlib.util
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools/dev"))
_spec = importlib.util.spec_from_file_location("attack_show", ROOT / "tools/dev/attack_show.py")
assert _spec and _spec.loader
show = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(show)


def test_attempt_lines_parsed() -> None:
    text, blocked = show.attempt_line("attempt 3: admin:123456 -> RTSP/1.0 401 Unauthorized\n")
    assert "第  3 次" in text and "admin / 123456" in text and "401" in text and not blocked
    text, blocked = show.attempt_line("attempt 7: admin:888888 -> connection failed: timed out")
    assert "连接被切断" in text and blocked
    assert show.attempt_line("rtsp-bruteforce: 5/12 denied by rtsp://rtsp-target:8554/cam") is None


def test_show_params_trigger_rule_and_avoid_real_passwords() -> None:
    """60 s 内超过 5 次才触发 HYD-NET-0001；口令只用公开的常见弱口令。"""
    params = yaml.safe_load((ROOT / "demo/scenarios/attack-sim.yaml").read_text(encoding="utf-8"))
    p = params["show"]
    assert p["attempts"] >= 6 and p["attempts"] * p["interval_s"] < 60
    assert len(p["wordlist"]) >= p["attempts"] // 2
    assert "admin123" not in [str(w) for w in p["wordlist"]]
