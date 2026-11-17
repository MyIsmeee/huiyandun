"""关联规则格式（architecture.md §12）：仓库内规则全部合法；非法规则拒绝加载并指出文件与字段。"""

import json
from pathlib import Path
from typing import Any

import pytest

from correlator.rules import load_rules

ROOT = Path(__file__).resolve().parents[3]


def test_repository_rules_load() -> None:
    rules = {r.id: r for r in load_rules(ROOT / "rules/correlator")}
    single, hijack, slow, rule = (
        rules[i] for i in ("HYD-NET-0101", "HYD-NET-0102", "HYD-NET-0103", "HYD-X-0001")
    )
    assert (rule.id, rule.mode, rule.window_s) == ("HYD-X-0001", "enforce", 300)
    assert [s.subject for s in rule.sequence] == [
        "hyd.security.alert.v1",
        "hyd.vision.integrity.v1",
    ]
    # 单域规则只接受规则来源的告警：模型来源的判定不得直接触发处置（FR-407）
    assert (single.id, single.mode, single.emit.severity) == ("HYD-NET-0101", "enforce", "high")
    assert [s.match for s in single.sequence] == [{"category": "auth_bruteforce", "source": "rule"}]
    assert (hijack.id, hijack.mode, hijack.emit.severity) == ("HYD-NET-0102", "enforce", "high")
    assert [s.match for s in hijack.sequence] == [{"category": "stream_hijack", "source": "rule"}]
    # 低速爆破只接受行为模型的认证爆破类判定；模型来源使关联事件须人工确认（FR-407）
    assert (slow.id, slow.mode, slow.emit.severity) == ("HYD-NET-0103", "enforce", "high")
    assert [s.match for s in slow.sequence] == [
        {"category": "behavior_anomaly", "source": "model", "technique": "T1110"}
    ]


def write_rule(directory: Path, name: str, **changes: Any) -> None:
    rule = next(r for r in load_rules(ROOT / "rules/correlator") if r.id == "HYD-X-0001")
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
