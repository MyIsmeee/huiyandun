"""Makefile 占位目标：对应任务实现前，执行即失败并指明负责的任务（TK-001）。

某个目标实现后，从 PLACEHOLDERS 中删除该项。
"""

import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]

PLACEHOLDERS = {
    "verify-models": "TK-021",
    "test-rules": "TK-030",
    "llm-check": "TK-060",
    "demo-run": "TK-100",
}


@pytest.mark.parametrize(("target", "task"), PLACEHOLDERS.items())
def test_placeholder_target_fails_with_task_id(target: str, task: str) -> None:
    result = subprocess.run(
        ["make", "--no-print-directory", "-C", str(ROOT), target],
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )

    assert result.returncode != 0
    assert f"由 {task} 实现" in result.stderr
