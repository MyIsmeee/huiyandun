"""Playbook 格式（architecture.md §12）：仓库内 Playbook 合法；非法的拒绝加载并指出文件与字段。"""

import json
from pathlib import Path
from typing import Any

import pytest

from playbook_executor.playbooks import load_playbooks

ROOT = Path(__file__).resolve().parents[3]


def test_repository_playbooks_load() -> None:
    local, linked = sorted(load_playbooks(ROOT / "playbooks"), key=lambda p: p.id)
    assert (local.id, local.trigger.rule_ids, local.ttl_s) == (
        "isolate-attacker",
        ["HYD-NET-0101", "HYD-NET-0102", "HYD-NET-0103", "HYD-X-0001"],
        1800,
    )
    assert local.trigger.severity == ["critical", "high"]
    assert local.target == "incident.source_ip"
    # 旁路模式经联动网关封禁：触发条件与本机封禁一致，只换执行位置（FR-1001）
    assert (linked.id, linked.requires_mode, linked.actions[0].adapter) == (
        "isolate-attacker-linked",
        ["bypass"],
        "firewall",
    )
    assert (linked.trigger, linked.target, linked.ttl_s) == (local.trigger, local.target, 1800)
    assert local.requires_mode == ["host_probe"]


def write(directory: Path, name: str, **changes: Any) -> None:
    playbook = next(p for p in load_playbooks(ROOT / "playbooks") if p.id == "isolate-attacker")
    data = playbook.model_dump(mode="json") | changes
    (directory / f"{name}.yaml").write_text(json.dumps(data), encoding="utf-8")


@pytest.mark.parametrize(
    ("name", "changes", "error"),
    [
        ("isolate-attacker", {"target": "ai.recommendation"}, "target"),  # G-03：不得引用 LLM 输出
        ("isolate-attacker", {"ttl_s": 86401}, "ttl_s"),  # C-BE-05 上限
        ("isolate-attacker", {"actions": [{"adapter": "shell", "action": "run"}]}, "adapter"),
        ("isolate-attacker", {"actions": []}, "actions"),
        ("isolate-attacker", {"on_failure": "ignore"}, "on_failure"),
        ("block-all", {}, "文件名"),
    ],
)
def test_invalid_playbook_rejected_with_file(
    tmp_path: Path, name: str, changes: dict[str, Any], error: str
) -> None:
    write(tmp_path, name, **changes)
    with pytest.raises(ValueError, match=error) as e:
        load_playbooks(tmp_path)
    assert name in str(e.value)
