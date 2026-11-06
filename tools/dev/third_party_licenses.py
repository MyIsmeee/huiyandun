"""生成 LICENSE-THIRD-PARTY.md（G-08、C-RU-02）：GPL 组件声明与语言包许可证清单。

容器镜像、规则、资产与 wheel 自带的二进制库逐项登记在 deploy/third-party.yaml，本文件不重复。
语言包取自锁文件：随产品分发的为 Python 运行时依赖与前端 dependencies（打包进前端静态文件），
构建期的为 Python dev 组中不进入运行时的包与前端 devDependencies。
用法：make licenses（依赖变化后重新生成并提交）
"""

import json
import subprocess
import sys

TIMEOUT_S = 120
WEB = "web/console"

Rows = list[tuple[str, str, str]]

HEADER = """# 第三方许可证声明

本文件由 `make licenses` 生成，依赖变化后重新生成并提交，不手工修改。

容器镜像、检测规则、场景资产与 Python 包自带的二进制库，逐项登记在 `deploy/third-party.yaml`
（名称、版本、许可证、用途，C-RU-01）。随产品分发的语言包见下文，许可证由 CI-09 按 HYD-ARCH-001 G-08
白名单检查。

## GPL 组件（独立进程运行）

以下组件以独立进程运行、不修改源码、不与自研代码链接（G-08、C-RU-02）：

| 组件 | 许可证 | 所在镜像 | 用途 |
|---|---|---|---|
| Suricata | GPL-2.0-only | `suricata` | 网络入侵检测（REUSE-08） |
| FFmpeg（GPL 构建） | GPL-2.0-or-later | MediaMTX 镜像（`mediamtx`、`rtsp-target`、`nvr-sim`、`recorder`、`ingest`） | 演示素材推流、持续录像与片段截取 |
| iproute2、ethtool | GPL-2.0 | `capture-tap`（Debian 包） | 配置抓包源的流量镜像 |
| nftables | GPL-2.0 | `privileged-helper`（Debian 包） | 封禁与解封（D-074） |

## 随产品分发的语言包
{distributed}
## 构建期依赖（不随产品分发）

只在开发、测试、构建阶段使用，不进入运行镜像，不受 G-08 白名单限制，按 G-08 末句登记。
"""


def run(*args: str) -> str:
    return subprocess.run(
        args, check=True, capture_output=True, text=True, timeout=TIMEOUT_S
    ).stdout


def names(export: str) -> set[str]:
    """`uv export` 输出中的包名。"""
    return {
        line.split("==", 1)[0].lower()
        for line in export.splitlines()
        if "==" in line and not line.startswith(" ")
    }


def python_rows() -> tuple[Rows, Rows]:
    """（运行时，构建期）。"""
    common = ("--frozen", "--no-emit-workspace", "--no-hashes", "--no-header", "--no-annotate")
    dev = names(run("uv", "export", "--only-dev", *common))
    runtime = names(run("uv", "export", "--no-dev", "--all-packages", *common))
    return pip_licenses(sorted(runtime)), pip_licenses(sorted(dev - runtime))


def pip_licenses(packages: list[str]) -> Rows:
    if not packages:
        return []
    out = run(
        "uv",
        "run",
        "--frozen",
        "pip-licenses",
        "--from=mixed",
        "--format=json",
        "--packages",
        *packages,
    )
    return [(p["Name"], p["Version"], p["License"]) for p in json.loads(out)]


def node_rows(scope: str) -> Rows:
    """scope 为 --prod 或 --dev。"""
    data = json.loads(run("pnpm", "--dir", WEB, "licenses", "list", scope, "--json"))
    return [
        (pkg["name"], ", ".join(pkg["versions"]), license)
        for license, pkgs in data.items()
        for pkg in pkgs
    ]


def table(title: str, rows: Rows) -> str:
    lines = [f"\n### {title}\n\n| 包 | 版本 | 许可证 |\n|---|---|---|\n"]
    lines += [f"| {n} | {v} | {lic} |\n" for n, v, lic in sorted(rows, key=lambda r: r[0].lower())]
    return "".join(lines)


def render(runtime: tuple[Rows, Rows], build: tuple[Rows, Rows]) -> str:
    """runtime、build 各为（Python，前端）。"""
    distributed = table("Python（`uv.lock` 的运行时依赖）", runtime[0]) + table(
        "前端（`pnpm-lock.yaml` 的 dependencies）", runtime[1]
    )
    return (
        HEADER.format(distributed=distributed)
        + table("Python（`uv.lock` 的 dev 组）", build[0])
        + table("前端（`pnpm-lock.yaml` 的 devDependencies）", build[1])
    )


def main() -> int:
    runtime, build = python_rows()
    sys.stdout.write(render((runtime, node_rows("--prod")), (build, node_rows("--dev"))))
    return 0


if __name__ == "__main__":
    sys.exit(main())
