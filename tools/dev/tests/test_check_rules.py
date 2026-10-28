"""检测规则测试脚本（CI-19）：以假的 suricata 代替容器，覆盖通过、告警数不符与规则加载失败。"""

import importlib.util
import json
import subprocess
from collections.abc import Callable
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "check_rules.py"
_spec = importlib.util.spec_from_file_location("check_rules", SCRIPT)
assert _spec and _spec.loader
check_rules = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(check_rules)


@pytest.fixture
def rules(tmp_path: Path) -> Path:
    case = tmp_path / "tests/HYD-NET-0001"
    case.mkdir(parents=True)
    (case / "hit.pcap").write_bytes(b"")
    (case / "hit.meta.yaml").write_text("alerts: 1\n", encoding="utf-8")
    return tmp_path


def fake_suricata(load_rc: int, alerts: int) -> Callable[..., subprocess.CompletedProcess[str]]:
    """-T 返回 load_rc；回放时只加载规则所在文件，写出 alerts 条本规则告警及其他规则的告警。"""

    def run(
        image: str, *args: str, volumes: tuple[str, ...] = ()
    ) -> subprocess.CompletedProcess[str]:
        if "-T" in args:
            return subprocess.CompletedProcess(args, load_rc, "", "rule error")
        assert args[args.index("-S") + 1] == "/etc/suricata/rules/hyd-net.rules"
        out = next(v.removesuffix(":/out") for v in volumes if v.endswith(":/out"))
        events = [{"event_type": "alert", "alert": {"metadata": {"hyd_rule_id": ["HYD-NET-0001"]}}}]
        events = events * alerts + [
            {"event_type": "alert", "alert": {"metadata": {"hyd_rule_id": ["HYD-NET-0002"]}}},
            {"event_type": "alert", "alert": {}},  # ET Open 规则不带 hyd_rule_id
            {"event_type": "stats"},
        ]
        Path(out, "eve.json").write_text("\n".join(map(json.dumps, events)), encoding="utf-8")
        return subprocess.CompletedProcess(args, 0, "", "")

    return run


@pytest.mark.parametrize(
    ("load_rc", "alerts", "code"),
    [(0, 1, 0), (0, 0, 1), (0, 2, 1), (1, 1, 1)],
    ids=["pass", "missed", "extra", "load-error"],
)
def test_main(
    rules: Path, monkeypatch: pytest.MonkeyPatch, load_rc: int, alerts: int, code: int
) -> None:
    monkeypatch.setattr(check_rules, "suricata", fake_suricata(load_rc, alerts))
    assert check_rules.main("image", rules) == code
