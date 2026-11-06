"""LICENSE-THIRD-PARTY.md 的生成（G-08、#36）：只测包名解析与渲染，不调用 uv、pnpm。"""

import importlib.util
import json
import sys
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "third_party_licenses.py"
_spec = importlib.util.spec_from_file_location("third_party_licenses", SCRIPT)
assert _spec is not None and _spec.loader is not None
licenses = importlib.util.module_from_spec(_spec)
sys.modules["third_party_licenses"] = licenses
_spec.loader.exec_module(licenses)


def test_pip_licenses_includes_its_own_dependencies(monkeypatch: pytest.MonkeyPatch) -> None:
    """复核阻断项：pip-licenses 默认略去自身及其依赖，须加 --with-system。"""
    calls: list[tuple[str, ...]] = []

    def run(*args: str) -> str:
        calls.append(args)
        return json.dumps(
            [
                {"Name": "pip-licenses", "Version": "5.0.0", "License": "MIT"},
                {"Name": "PrettyTable", "Version": "3.16.0", "License": "BSD-3-Clause"},
            ]
        )

    monkeypatch.setattr(licenses, "run", run)
    rows = licenses.pip_licenses(["pip-licenses", "prettytable"])
    assert "--with-system" in calls[0]
    assert [r[0] for r in rows] == ["pip-licenses", "PrettyTable"]
    with pytest.raises(SystemExit, match="wcwidth"):
        licenses.pip_licenses(["pip-licenses", "prettytable", "wcwidth"])


def test_names_skips_continuation_lines() -> None:
    export = "PyYAML==6.0.3 \\\n    --hash=sha256:00\nruff==0.15.2\n"
    assert licenses.names(export) == {"pyyaml", "ruff"}


def test_names_skips_packages_never_installed_here() -> None:
    """override 排除的与其他平台专用的包不会安装，不登记。"""
    export = (
        "av==19.0.2 ; sys_platform == 'never'\n"
        "colorama==0.4.6 ; sys_platform == 'win32'\n"
        "typing_extensions==4.16.0 ; python_full_version >= '3.12'\n"
    )
    assert licenses.names(export) == {"typing-extensions"}


def test_render_lists_gpl_components_and_sorted_rows_per_section() -> None:
    text = licenses.render(
        ([("react", "19.3.1", "MIT")], [("three", "0.180.0", "MIT")]),
        (
            [("ruff", "0.15.2", "MIT"), ("argcomplete", "3.7.2", "Apache-2.0")],
            [("lru-cache", "11.5.3", "BlueOak-1.0.0"), ("caniuse-lite", "1.0.1", "CC-BY-4.0")],
        ),
    )
    assert "| Suricata | GPL-2.0-only |" in text
    distributed, build = text.split("## 构建期依赖")
    assert "| react | 19.3.1 | MIT |" in distributed and "| three |" in distributed
    assert "ruff" not in distributed and "lru-cache" not in distributed
    python, node = build.split("### Python")[1].split("### 前端")
    assert python.index("argcomplete") < python.index("ruff")
    assert node.index("caniuse-lite") < node.index("lru-cache")
