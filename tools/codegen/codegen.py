"""由 contracts/ 生成 libs/py-contracts 的 Pydantic v2 模型（R-05、CD-09）。

用法：python tools/codegen/codegen.py [--check]
生成参数见 pyproject.toml 的 [tool.datamodel-codegen]。
--check：生成到临时目录并与仓库中的生成代码比较；不一致时输出 diff 并以 1 退出（CI-08）。
"""

import difflib
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

# (契约目录, 输入格式, 生成目录)
TARGETS = [
    (Path("contracts/events"), "jsonschema", Path("libs/py-contracts/src/py_contracts/events")),
]


def generate(src: Path, kind: str, out: Path) -> dict[str, str]:
    subprocess.run(
        ["datamodel-codegen", "--input", str(src), "--input-file-type", kind, "--output", str(out)],
        check=True,
        timeout=120,
    )
    return modules(out)


def modules(root: Path) -> dict[str, str]:
    return {p.relative_to(root).as_posix(): p.read_text() for p in sorted(root.rglob("*.py"))}


def diff(out: Path, expected: dict[str, str]) -> list[str]:
    actual = modules(out) if out.exists() else {}
    return [
        line
        for name in sorted(expected.keys() | actual.keys())
        for line in difflib.unified_diff(
            actual.get(name, "").splitlines(keepends=True),
            expected.get(name, "").splitlines(keepends=True),
            f"{out}/{name}",
            f"{out}/{name}（由契约生成）",
        )
    ]


def write(out: Path, expected: dict[str, str]) -> None:
    if out.exists():
        shutil.rmtree(out)
    for name, text in expected.items():
        (out / name).parent.mkdir(parents=True, exist_ok=True)
        (out / name).write_text(text)


def main(args: list[str]) -> int:
    check = args == ["--check"]
    stale: list[str] = []
    # 临时目录放在仓库内，使 ruff 读取与 make lint 相同的配置
    with tempfile.TemporaryDirectory(dir=".") as tmp:
        for src, kind, out in TARGETS:
            expected = generate(src, kind, Path(tmp) / out.name)
            if check:
                stale += diff(out, expected)
            else:
                write(out, expected)
    if stale:
        sys.stdout.writelines(stale)
        print(
            "生成代码与 contracts/ 不一致：运行 make codegen 并提交生成结果（R-05）",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
