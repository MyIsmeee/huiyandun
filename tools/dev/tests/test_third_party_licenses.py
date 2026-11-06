"""LICENSE-THIRD-PARTY.md 的生成（G-08、#36）：只测包名解析与渲染，不调用 uv、pnpm。"""

import importlib.util
import sys
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "third_party_licenses.py"
_spec = importlib.util.spec_from_file_location("third_party_licenses", SCRIPT)
assert _spec is not None and _spec.loader is not None
licenses = importlib.util.module_from_spec(_spec)
sys.modules["third_party_licenses"] = licenses
_spec.loader.exec_module(licenses)


def test_names_skips_continuation_lines() -> None:
    export = "PyYAML==6.0.3 \\\n    --hash=sha256:00\nruff==0.15.2\n"
    assert licenses.names(export) == {"pyyaml", "ruff"}


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
