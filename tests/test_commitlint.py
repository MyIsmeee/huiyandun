"""commitlint 配置：type / scope 枚举、subject 长度与 Issue 引用（CI-01、CM-01、CM-03、P-04）。"""

import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


def lint(message: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["pnpm", "exec", "commitlint"],
        input=message,
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )


@pytest.mark.parametrize(
    "message",
    [
        "feat(llm-gw): 增加出域请求脱敏器\n\n涉及约束：G-02。\n\nCloses: #142",
        "fix: 修复超时未生效\n\nRefs: #7\n\nCo-Authored-By: A <a@example.com>",
        "security(helper): 校验指令签名\n\nCloses: #3",
        "docs: 更新 README",
        "chore(deps): 升级 ruff",
    ],
)
def test_accepts_valid_message(message: str) -> None:
    result = lint(message)

    assert result.returncode == 0, result.stdout


@pytest.mark.parametrize(
    "message",
    [
        "feat(llm-gw): 增加出域请求脱敏器",
        "feat(llm-gw): 增加出域请求脱敏器\n\nSee #142",
        "feat(gateway): 增加出域请求脱敏器\n\nCloses: #142",
        "feature(llm-gw): 增加出域请求脱敏器\n\nCloses: #142",
        "chore(ci): 调整流水线",
        f"feat(api): {'很' * 73}\n\nCloses: #1",
        "feat(api): 增加告警接口。\n\nCloses: #1",
    ],
    ids=[
        "no-ref",
        "bad-ref",
        "bad-scope",
        "bad-type",
        "chore-not-deps",
        "long-subject",
        "cjk-full-stop",
    ],
)
def test_rejects_invalid_message(message: str) -> None:
    assert lint(message).returncode != 0
