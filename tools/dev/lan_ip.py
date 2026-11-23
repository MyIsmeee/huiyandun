"""本机局域网地址（D-143，ops.md §5）：make demo-up 时探测，作为 docker compose 的 HYD_LAN_IP。

deploy/compose/.env 中显式写的 HYD_LAN_IP 优先；否则在 WSL 中经 powershell.exe 查 Windows 的默认路由，取开销
（路由 + 网卡）最小、地址不在排除网段的网卡；探测不到时为 127.0.0.1（只供本机访问）。只打印地址，不改任何配置。
"""

import ipaddress
import re
import shutil
import subprocess
import sys
from pathlib import Path

ENV = Path(__file__).resolve().parents[2] / "deploy/compose/.env"
FALLBACK = "127.0.0.1"
# 代理软件 TUN 网卡的假地址段（如 mihomo 的 198.18.0.1）也有默认路由，不是局域网地址
EXCLUDED = [ipaddress.ip_network(n) for n in ("198.18.0.0/15", "169.254.0.0/16", "127.0.0.0/8")]
# 每行"开销 地址"：一条 IPv4 默认路由的开销（路由 + 网卡）与该网卡的 IPv4 地址
QUERY = (
    "Get-NetRoute -AddressFamily IPv4 -DestinationPrefix 0.0.0.0/0 | ForEach-Object { "
    "$m = $_.RouteMetric + (Get-NetIPInterface -InterfaceIndex $_.ifIndex -AddressFamily IPv4)"
    ".InterfaceMetric; Get-NetIPAddress -InterfaceIndex $_.ifIndex -AddressFamily IPv4 | "
    'ForEach-Object { "$m $($_.IPAddress)" } }'
)
TIMEOUT_S = 20


def configured(env: str) -> str | None:
    """.env 中显式写的 HYD_LAN_IP；与 docker compose 一致，去掉引号，空白后的 # 起为行尾注释。"""
    match = re.search(
        r"""^\s*HYD_LAN_IP\s*=\s*(?:"([^"]+)"|'([^']+)'|(\S+))(?:\s+#.*)?\s*$""", env, re.MULTILINE
    )
    return next(v for v in match.groups() if v) if match else None


def pick(lines: str) -> str | None:
    """各行"开销 地址"中开销最小、不在排除网段的 IPv4 地址。"""
    usable = []
    for line in lines.splitlines():
        try:
            metric, address = line.split()
            ip = ipaddress.ip_address(address)
            usable.append((int(metric), ip))
        except ValueError:
            continue
    usable = [(m, ip) for m, ip in usable if ip.version == 4 and not any(ip in n for n in EXCLUDED)]
    return str(min(usable)[1]) if usable else None


def detect() -> str | None:
    """WSL 之外（没有 powershell.exe）或查询失败时为 None。"""
    if shutil.which("powershell.exe") is None:
        return None
    try:
        result = subprocess.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", QUERY],
            capture_output=True,
            timeout=TIMEOUT_S,
            check=True,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    # 不解码 stderr：中文 Windows 上它是 GBK；stdout 中所需的"开销 地址"只含 ASCII，其余字符替换后由 pick 跳过
    return pick(result.stdout.decode("ascii", "replace"))


def main() -> None:
    address = (configured(ENV.read_text(encoding="utf-8")) if ENV.exists() else None) or detect()
    if address is None:
        print(
            f"未探测到本机局域网地址，HYD_LAN_IP 取 {FALLBACK}（只供本机访问）；"
            "可在 deploy/compose/.env 写 HYD_LAN_IP=<IP>",
            file=sys.stderr,
        )
        address = FALLBACK
    print(address)


if __name__ == "__main__":
    main()
