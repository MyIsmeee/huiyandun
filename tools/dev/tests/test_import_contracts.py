"""import-linter 契约（CI-06）确实拦截违规 import：在源码副本中写入违规 import，断言对应契约报 BROKEN。"""

import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
LINT_IMPORTS = Path(sys.executable).parent / "lint-imports"

INDEPENDENCE = "服务之间只经事件总线或 HTTP 通信"
OPENAI = "只有 llm-gateway 使用 openai 客户端"
ACTIONS = "处置链路不引用任何 LLM 客户端"
VISION = "vision-engine 只发事件，不写业务库"


def lint(src: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [str(LINT_IMPORTS), "--config", str(ROOT / "pyproject.toml"), "--no-cache"],
        cwd=ROOT,
        env={**os.environ, "PYTHONPATH": str(src)},
        capture_output=True,
        text=True,
        timeout=120,
    )


@pytest.fixture(scope="module")
def src(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """全部服务与共享库源码的副本；PYTHONPATH 指向它，优先于已安装的包。"""
    dst = tmp_path_factory.mktemp("src")
    for pkg in sorted(ROOT.glob("services/*/src/*")) + sorted(ROOT.glob("libs/*/src/*")):
        if (pkg / "__init__.py").exists():
            shutil.copytree(pkg, dst / pkg.name, ignore=shutil.ignore_patterns("__pycache__"))
    return dst


def test_current_code_keeps_all_contracts(src: Path) -> None:
    result = lint(src)
    assert result.returncode == 0, result.stdout
    assert "4 kept, 0 broken" in result.stdout


@pytest.mark.parametrize(
    ("package", "statement", "broken"),
    [
        ("playbook_executor", "import openai", {OPENAI, ACTIONS}),
        ("privileged_helper", "import llm_gateway", {INDEPENDENCE, ACTIONS}),
        ("playbook_executor", "import httpx2", {ACTIONS}),
        ("api_server", "import openai", {OPENAI}),
        ("vision_engine", "import sqlalchemy", {VISION}),
        ("correlator", "import api_server", {INDEPENDENCE}),
    ],
)
def test_violation_breaks_contract(
    src: Path, package: str, statement: str, broken: set[str]
) -> None:
    violation = src / package / "_violation.py"
    violation.write_text(statement + "\n", encoding="utf-8")
    try:
        result = lint(src)
    finally:
        violation.unlink()
    assert result.returncode == 1, result.stdout
    for name in (INDEPENDENCE, OPENAI, ACTIONS, VISION):
        # 汇总区每条契约一行："<名称> KEPT" 或 "<名称> BROKEN"
        line = next(ln for ln in result.stdout.splitlines() if name in ln)
        assert ("BROKEN" in line) is (name in broken), line
