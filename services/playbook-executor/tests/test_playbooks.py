"""Playbook 格式（HYD-PLAN-007 §5）：仓库内 Playbook 合法；非法的拒绝加载并指出文件与字段。"""

import json
from pathlib import Path
from typing import Any

import pytest

from playbook_executor.playbooks import load_playbooks

ROOT = Path(__file__).resolve().parents[3]


def test_repository_playbooks_load() -> None:
    (playbook,) = load_playbooks(ROOT / "playbooks")
    assert (playbook.id, playbook.trigger.rule_ids, playbook.ttl_s) == (
        "isolate-attacker",
        ["HYD-X-0001"],
        1800,
    )
    assert playbook.target == "incident.source_ip"


def write(directory: Path, name: str, **changes: Any) -> None:
    (playbook,) = load_playbooks(ROOT / "playbooks")
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
