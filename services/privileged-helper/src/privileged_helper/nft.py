"""nftables 固定模板（D-074）：只以参数列表调用 nft（GPL-2.0，独立进程，G-08），不拼接 shell。

封禁表 inet hyd：集合 block4 / block6 带超时与逐元素计数。forward 链对往来于其中地址的 TCP 报文回复 RST、
其余协议丢弃；input 链对来自其中地址的报文同样处理。到期由内核删除元素，helper 或 executor 重启都不影响到期解除。

切断已建立的会话：只丢包时，封禁前已建立的连接仍留在两端，设备会继续重传、攻击方的套接字迟迟不关。对 TCP 回复
RST 后，任一端再发出一个报文，发送方即收到复位并关闭连接——攻击方发往设备的报文复位攻击方一端（saddr 规则），
设备发往攻击方的报文复位设备一端（forward 链的 daddr 规则，同时拦下仍在外发的码流）。
"""

import asyncio
import json
from collections.abc import Awaitable, Callable
from ipaddress import IPv4Address, IPv6Address

TABLE = "hyd"
TIMEOUT_S = 5.0  # 每次调用 nft 的上限（CD-04）
# 一次事务内完成，可重复执行：表、集合、链的声明是"不存在才创建"，已有集合里的封禁原样保留；规则先清空再写入，
# 所以不会叠加，旧版本留下的表也随之升级到当前规则。
# 每条规则先判协议再查集合：查集合即计数，TCP 报文在复位规则处终止、其余协议只在丢弃规则处查一次，各计一次。
SETUP = """
table inet hyd {
  set block4 { type ipv4_addr; flags timeout; counter; }
  set block6 { type ipv6_addr; flags timeout; counter; }
  chain forward { type filter hook forward priority -10; policy accept; }
  chain input { type filter hook input priority -10; policy accept; }
}
flush chain inet hyd forward
flush chain inet hyd input
table inet hyd {
  chain forward {
    meta l4proto tcp ip saddr @block4 reject with tcp reset
    meta l4proto tcp ip6 saddr @block6 reject with tcp reset
    meta l4proto tcp ip daddr @block4 reject with tcp reset
    meta l4proto tcp ip6 daddr @block6 reject with tcp reset
    ip saddr @block4 drop
    ip6 saddr @block6 drop
    ip daddr @block4 drop
    ip6 daddr @block6 drop
  }
  chain input {
    meta l4proto tcp ip saddr @block4 reject with tcp reset
    meta l4proto tcp ip6 saddr @block6 reject with tcp reset
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
        """写入封禁表（见 SETUP）：已有的封禁照常到期，规则更新为当前模板。"""
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
