"""nftables 固定模板（D-074）：只以参数列表调用 nft（GPL-2.0，独立进程，G-08），不拼接 shell。

封禁表 inet hyd：集合 block4 / block6 带超时与逐元素计数，forward 与 input 链丢弃其中的源地址。
到期由内核删除元素，helper 或 executor 重启都不影响到期解除。
"""

import asyncio
import json
from collections.abc import Awaitable, Callable
from ipaddress import IPv4Address, IPv6Address

TABLE = "hyd"
TIMEOUT_S = 5.0  # 每次调用 nft 的上限（CD-04）
SETUP = """
table inet hyd {
  set block4 { type ipv4_addr; flags timeout; counter; }
  set block6 { type ipv6_addr; flags timeout; counter; }
  chain forward {
    type filter hook forward priority -10; policy accept;
    ip saddr @block4 drop
    ip6 saddr @block6 drop
  }
  chain input {
    type filter hook input priority -10; policy accept;
    ip saddr @block4 drop
    ip6 saddr @block6 drop
  }
}
"""

type Ip = IPv4Address | IPv6Address
# (参数, 标准输入) → (退出码, 标准输出, 标准错误)；测试以假实现代替
type Runner = Callable[[list[str], str | None], Awaitable[tuple[int, str, str]]]


class NftError(RuntimeError):
    pass


async def run_nft(args: list[str], stdin: str | None = None) -> tuple[int, str, str]:
    proc = await asyncio.create_subprocess_exec(
        "nft",
        *args,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        out, err = await asyncio.wait_for(
            proc.communicate(stdin.encode() if stdin else None), TIMEOUT_S
        )
    except TimeoutError:
        proc.kill()
        raise
    return proc.returncode or 0, out.decode(), err.decode()


def _set(ip: Ip) -> str:
    return "block4" if isinstance(ip, IPv4Address) else "block6"


class Nft:
    def __init__(self, runner: Runner = run_nft) -> None:
        self._run = runner

    async def _check(self, args: list[str], stdin: str | None = None) -> str:
        code, out, err = await self._run(args, stdin)
        if code:
            raise NftError(err.strip() or f"nft 退出码 {code}")
        return out

    async def setup(self) -> None:
        """表已存在则保留（其中的封禁照常到期），否则创建；重复创建会叠加丢弃规则。"""
        code, _, _ = await self._run(["list", "table", "inet", TABLE], None)
        if code:
            await self._check(["-f", "-"], SETUP)

    async def block(self, ip: Ip, ttl_s: int) -> None:
        await self._check(
            ["add", "element", "inet", TABLE, _set(ip), f"{{ {ip} timeout {ttl_s}s }}"]
        )

    async def unblock(self, ip: Ip) -> None:
        """元素已到期删除时同样视为成功。"""
        code, _, err = await self._run(
            ["delete", "element", "inet", TABLE, _set(ip), f"{{ {ip} }}"], None
        )
        if code and "No such file or directory" not in err:
            raise NftError(err.strip() or f"nft 退出码 {code}")

    async def counters(self, ip: Ip) -> tuple[int, int] | None:
        """(拦截的数据包数, 剩余秒数)；元素不在集合中时为 None。"""
        out = await self._check(["-j", "list", "set", "inet", TABLE, _set(ip)])
        for item in json.loads(out)["nftables"]:
            for elem in item.get("set", {}).get("elem", []):
                value = elem.get("elem", {})
                if value.get("val") == str(ip):
                    return value["counter"]["packets"], value["expires"]
        return None
