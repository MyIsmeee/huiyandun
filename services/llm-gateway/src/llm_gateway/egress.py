"""出域复核（G-02、C-LLM-13）：按供应商地址实际指向哪里判断，不只看 api-server 给的网络位置标签。

api-server 按地址字面给供应商标内网或公网，域名一律按公网，管理员可以改判；"全局禁止公网"与公网脱敏都依据这个
标签。标签是人填的：把指向公网的域名改判为内网，数据就会不经脱敏发出去，总开关也拦不住。网关在发出请求前把主机名
解析一遍，以解析出的地址为准再判一次：
- 全局禁止公网开启时，标签为公网、解析不出、或解析出任一公网地址的供应商一律不调用；
- 未开启时，解析出公网地址的供应商即使标为内网也按公网脱敏。

这是标签之外的第二道检查，不能替代网络层的出站限制：解析与实际连接是两次查询，恶意的 DNS 可以让两次结果不同。
"""

import asyncio
import socket
from collections.abc import Awaitable, Callable
from ipaddress import ip_address, ip_network
from urllib.parse import urlsplit

# 与 api-server 的 INTERNAL_NETWORKS 一致（C-LLM-13）：回环、私有网段、链路本地为内网
INTERNAL_NETWORKS = [
    ip_network(n)
    for n in (
        "127.0.0.0/8",
        "::1/128",
        "10.0.0.0/8",
        "172.16.0.0/12",
        "192.168.0.0/16",
        "fc00::/7",
        "169.254.0.0/16",
        "fe80::/10",
    )
]
RESOLVE_TIMEOUT_S = 2.0

# 主机名 → 解析出的地址；解析不出时抛 OSError。测试以假实现代替
type Resolver = Callable[[str], Awaitable[list[str]]]

BLOCKED = "已开启全局禁止公网，未向该地址发送请求"


async def resolve(host: str) -> list[str]:
    loop = asyncio.get_running_loop()
    async with asyncio.timeout(RESOLVE_TIMEOUT_S):
        infos = await loop.getaddrinfo(host, None, type=socket.SOCK_STREAM)
    return sorted({info[4][0] for info in infos})


def _internal(address: str) -> bool:
    addr = ip_address(address.split("%", 1)[0])  # 去掉 IPv6 的接口后缀
    mapped = getattr(addr, "ipv4_mapped", None)
    addr = mapped or addr
    return any(addr in n for n in INTERNAL_NETWORKS)


async def public_addresses(base_url: str, resolver: Resolver = resolve) -> list[str] | None:
    """供应商主机指向的公网地址；全部在内网时为空列表，主机名解析不出（或地址写错）时为 None。"""
    try:
        host = urlsplit(base_url).hostname
    except ValueError:
        return None
    if not host:
        return None
    try:
        addresses = [host] if _literal(host) else await resolver(host)
        return [a for a in addresses if not _internal(a)] if addresses else None
    except (OSError, TimeoutError, ValueError):
        return None


def _literal(host: str) -> bool:
    try:
        ip_address(host)
    except ValueError:
        return False
    return True


async def blocked_reason(
    base_url: str, network: str, block_public: bool, resolver: Resolver = resolve
) -> str | None:
    """全局禁止公网开启时不得调用这一家的原因；可以调用为 None。"""
    if not block_public:
        return None
    if network == "public":
        return BLOCKED
    outside = await public_addresses(base_url, resolver)
    if outside is None:
        return f"{BLOCKED}：无法确认该地址在内网（主机名解析不出）"
    if outside:
        return f"{BLOCKED}：标为内网，但实际指向公网地址 {outside[0]}"
    return None
