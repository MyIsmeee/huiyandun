"""由 contracts/ 生成 libs/py-contracts 包（R-05、CD-09）。

用法：python tools/codegen/codegen.py [--check]
整个包均为生成结果：静态文件取自 tools/codegen/package/，模型由 datamodel-codegen 生成，
生成参数见 pyproject.toml 的 [tool.datamodel-codegen]。
--check：生成到临时目录并与仓库中的包比较；不一致时输出 diff 并以 1 退出（CI-08）。
"""

import difflib
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

PACKAGE = Path("libs/py-contracts")
TEMPLATE = Path("tools/codegen/package")
# OpenAPI 以相对路径引用 contracts/events 的实体 Schema，输入目录之外的本地文件须显式放行；
# 该开关同时放行 HTTP 引用，但 contracts/ 中的公网 URL 由 CI-07 拦截，且只在构建期生效
OPENAPI_ARGS = ["--use-title-as-name", "--allow-remote-refs"]
# (契约, 输入格式, 包内生成位置, 额外参数)
TARGETS = [
    (Path("contracts/events"), "jsonschema", Path("src/py_contracts/events"), []),
    (
        Path("contracts/openapi/api-server.v1.yaml"),
        "openapi",
        Path("src/py_contracts/api.py"),
        OPENAPI_ARGS,
    ),
]


def build(root: Path) -> dict[str, str]:
    shutil.copytree(TEMPLATE, root, ignore=shutil.ignore_patterns("__pycache__"))
    for src, kind, out, extra in TARGETS:
        subprocess.run(
            ["datamodel-codegen", "--input", str(src), "--input-file-type", kind]
            + ["--output", str(root / out), *extra],
            check=True,
            timeout=120,
        )
    return files(root)


def files(root: Path) -> dict[str, str]:
    return {
        p.relative_to(root).as_posix(): p.read_text()
        for p in sorted(root.rglob("*"))
        if p.is_file() and "__pycache__" not in p.parts
    }


def diff(expected: dict[str, str]) -> list[str]:
    actual = files(PACKAGE) if PACKAGE.exists() else {}
    return [
        line
        for name in sorted(expected.keys() | actual.keys())
        for line in difflib.unified_diff(
            actual.get(name, "").splitlines(keepends=True),
            expected.get(name, "").splitlines(keepends=True),
            f"{PACKAGE}/{name}",
            f"{PACKAGE}/{name}（由契约生成）",
        )
    ]


def write(expected: dict[str, str]) -> None:
    if PACKAGE.exists():
        shutil.rmtree(PACKAGE)
    for name, text in expected.items():
        (PACKAGE / name).parent.mkdir(parents=True, exist_ok=True)
        (PACKAGE / name).write_text(text)


def main(args: list[str]) -> int:
    if args not in ([], ["--check"]):
        print(f"未知参数：{' '.join(args)}；用法：codegen.py [--check]", file=sys.stderr)
        return 2
    # 临时目录放在仓库内，使 ruff 读取与 make lint 相同的配置
    with tempfile.TemporaryDirectory(dir=".") as tmp:
        expected = build(Path(tmp) / PACKAGE.name)
    if not args:
        write(expected)
        return 0
    stale = diff(expected)
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
