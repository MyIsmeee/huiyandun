"""关联规则格式（HYD-PLAN-007 §4）：仓库内规则全部合法；非法规则拒绝加载并指出文件与字段。"""

import json
from pathlib import Path
from typing import Any

import pytest

from correlator.rules import load_rules

ROOT = Path(__file__).resolve().parents[3]


def test_repository_rules_load() -> None:
    (rule,) = load_rules(ROOT / "rules/correlator")
    assert (rule.id, rule.mode, rule.window_s) == ("HYD-X-0001", "enforce", 300)
    assert [s.subject for s in rule.sequence] == [
        "hyd.security.alert.v1",
        "hyd.vision.integrity.v1",
    ]


def write_rule(directory: Path, name: str, **changes: Any) -> None:
    (rule,) = load_rules(ROOT / "rules/correlator")
    data = rule.model_dump(mode="json") | changes
    (directory / f"{name}.yaml").write_text(json.dumps(data), encoding="utf-8")


@pytest.mark.parametrize(
    ("name", "changes", "error"),
    [
        ("HYD-X-0001", {"mode": "block"}, "mode"),
        ("HYD-X-0001", {"severity": "critical"}, "severity"),  # 未知字段
        (
            "HYD-X-0001",
            {"sequence": [{"subject": "hyd.security.alert.v1", "match": {"categroy": "x"}}]},
            "categroy",
        ),
        ("HYD-X-0002", {}, "文件名"),
    ],
)
def test_invalid_rule_rejected_with_file(
    tmp_path: Path, name: str, changes: dict[str, Any], error: str
) -> None:
    write_rule(tmp_path, name, **changes)
    with pytest.raises(ValueError, match=error) as e:
        load_rules(tmp_path)
    assert name in str(e.value)
