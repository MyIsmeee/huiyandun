"""CI-07：扫描公网 URL（G-05、C-FE-01）。

用法：python tools/lint/no_public_url.py [路径 ...]
不带参数时扫描 git 跟踪及未被忽略的文件；参数为目录时递归扫描（用于 dist/）。
发现公网地址时逐条输出 `文件:行号: URL`，并以 1 退出；参数路径不存在时以 2 退出。
"""

import ipaddress
import re
import subprocess
import sys
from fnmatch import fnmatch
from pathlib import Path

# 协议相对地址（//host）只在引号或括号后识别，避免把 // 注释当作 URL；可选的 userinfo@ 不计入主机
URL = re.compile(
    r"(?:\b(?:https?|wss?):|(?<=[(\"'`]))//(?:[^\s/?#@\"'`]+@)?([A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])",
    re.IGNORECASE,
)
# DOM 规范的命名空间标识符：只作字符串比较，不会被请求，前端构建产物中普遍存在
NAMESPACES = (
    "http://www.w3.org/1999/xhtml",
    "http://www.w3.org/1998/Math/MathML",
    "http://www.w3.org/2000/svg",
    "http://www.w3.org/1999/xlink",
    "http://www.w3.org/XML/1998/namespace",
    "http://www.w3.org/2000/xmlns/",
)
# 依赖固定写入构建产物的文本，同样不会被请求：React 生产包错误说明的链接前缀、Tailwind 许可证注释。
# 只在显式指定路径（扫描 dist/）时放行，源码中出现仍报告
INERT_TEXT = (
    "https://react.dev/errors/",
    "https://tailwindcss.com */",
    # three 着色器注释中引用的论文
    "https://jcgt.org/published/0007/04/01/",
    # @react-three/fiber 与 react-use-measure 的错误说明
    "https://docs.pmnd.rs/react-three-fiber/api/",
    "https://github.com/react-spring/react-use-measure/#",
    # @react-three/fiber 内联到包中的 package.json 元数据（作者、仓库、赞助页）
    "https://github.com/drcmda)",
    "https://github.com/joshuaellis)",
    "https://github.com/codyjasonbennett)",
    "https://github.com/krispya)",
    "https://github.com/pmndrs/react-three-fiber#readme`",
    "https://github.com/pmndrs/react-three-fiber.git`",
    "https://github.com/pmndrs/react-three-fiber/issues`",
    "https://opencollective.com/react-three-fiber`",
)
# 不会解析到公网的保留域名：RFC 2606、RFC 6761、ICANN .internal、mDNS .local
RESERVED_SUFFIXES = (".localhost", ".local", ".internal", ".test", ".example", ".invalid")
EXAMPLE_DOMAINS = ("example.com", "example.org", "example.net")
# 运行时不加载的文件：锁文件中的包源、文档链接、托管 Runner 上的 CI 配置、测试数据、本扫描器的放行清单
EXCLUDED = (
    "uv.lock",
    "pnpm-lock.yaml",
    "*.md",
    ".github/*",
    "tests/*",
    "*/tests/*",
    "tools/lint/no_public_url.py",
)


def is_public(host: str) -> bool:
    host = host.strip("[]").rstrip(".").lower()
    try:
        return ipaddress.ip_address(host).is_global
    except ValueError:
        pass
    if "." not in host:  # 单标签主机名：localhost、容器服务名
        return False
    if host.endswith(RESERVED_SUFFIXES):
        return False
    return not any(host == d or host.endswith("." + d) for d in EXAMPLE_DOMAINS)


def git_files() -> list[Path]:
    out = subprocess.run(
        ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
        capture_output=True,
        text=True,
        timeout=30,
        check=True,
    ).stdout
    return [Path(p) for p in out.split("\0") if p]


def scan(path: Path, allowed: tuple[str, ...]) -> list[str]:
    data = path.read_bytes()
    if b"\0" in data[:8192]:  # 二进制文件
        return []
    return [
        f"{path.as_posix()}:{lineno}: {m.group(0)}"
        for lineno, line in enumerate(data.decode("utf-8", "replace").splitlines(), 1)
        for m in URL.finditer(line)
        if is_public(m.group(1)) and not line.startswith(allowed, m.start())
    ]


def main(args: list[str]) -> int:
    missing = [a for a in args if not Path(a).exists()]
    if missing:
        print(f"路径不存在：{', '.join(missing)}", file=sys.stderr)
        return 2
    paths = [p for a in map(Path, args) for p in ([a] if a.is_file() else sorted(a.rglob("*")))]
    hits = [
        hit
        for path in (paths if args else git_files())
        if path.is_file() and not any(fnmatch(path.as_posix(), e) for e in EXCLUDED)
        for hit in scan(path, NAMESPACES + INERT_TEXT if args else NAMESPACES)
    ]
    for hit in hits:
        print(hit)
    if hits:
        print(f"发现 {len(hits)} 处公网 URL：运行时不得访问外部地址（G-05）", file=sys.stderr)
    return 1 if hits else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
