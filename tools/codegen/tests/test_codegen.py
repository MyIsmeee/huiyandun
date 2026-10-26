"""契约代码生成与一致性校验（R-05、CD-09、CI-08）。"""

import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
GENERATED = Path("libs/py-contracts/src/py_contracts/events")


def run(cwd: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "tools/codegen/codegen.py", *args],
        cwd=cwd,
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    for path in ("pyproject.toml", "contracts", "tools/codegen", "libs/py-contracts"):
        src, dst = ROOT / path, tmp_path / path
        dst.parent.mkdir(parents=True, exist_ok=True)
        if src.is_dir():
            shutil.copytree(src, dst, ignore=shutil.ignore_patterns("__pycache__"))
        else:
            shutil.copy2(src, dst)
    return tmp_path


def test_check_passes_when_generated_code_is_current(repo: Path) -> None:
    result = run(repo, "--check")

    assert result.returncode == 0, result.stdout + result.stderr


def test_check_fails_when_generated_code_is_edited(repo: Path) -> None:
    module = repo / GENERATED / "hyd_vision_track_v1_schema.py"
    module.write_text(module.read_text() + "\n# 手改\n")

    result = run(repo, "--check")

    assert result.returncode == 1
    assert "hyd_vision_track_v1_schema.py" in result.stdout


def test_check_fails_when_package_file_is_edited(repo: Path) -> None:
    manifest = repo / "libs/py-contracts/pyproject.toml"
    manifest.write_text(manifest.read_text() + "# 手改\n")

    result = run(repo, "--check")

    assert result.returncode == 1
    assert "libs/py-contracts/pyproject.toml" in result.stdout


def test_rejects_unknown_argument_without_writing(repo: Path) -> None:
    (repo / GENERATED / "stale.py").write_text("")

    result = run(repo, "--chek")

    assert result.returncode == 2
    assert "--chek" in result.stderr
    assert (repo / GENERATED / "stale.py").exists()


def test_check_fails_when_schema_is_not_regenerated(repo: Path) -> None:
    schema = {"title": "DemoV1", "type": "object", "properties": {"a": {"type": "string"}}}
    (repo / "contracts/events/hyd.demo.v1.schema.json").write_text(json.dumps(schema))

    result = run(repo, "--check")

    assert result.returncode == 1
    assert "hyd_demo_v1_schema.py" in result.stdout


def test_generate_makes_check_pass(repo: Path) -> None:
    schema = {"title": "DemoV1", "type": "object", "properties": {"a": {"type": "string"}}}
    (repo / "contracts/events/hyd.demo.v1.schema.json").write_text(json.dumps(schema))
    (repo / GENERATED / "stale.py").write_text("")

    assert run(repo).returncode == 0
    assert (repo / GENERATED / "hyd_demo_v1_schema.py").exists()
    assert not (repo / GENERATED / "stale.py").exists()
    assert run(repo, "--check").returncode == 0
