"""block_ip 动作（TK-051、D-074）：经 privileged-helper 的签名指令封禁源地址。

封禁写入内核集合并带超时，到期由内核解除；verify 列出集合确认元素已生效（D-072）。封禁生效后，攻击源与设备
之间已建立的 TCP 会话由内核回复 RST 切断，其余协议丢弃（规则见 privileged_helper.nft）。

两条通道、同一协议：
- nftables 适配器：本机 Unix 域套接字，封禁作用于边缘主机自身的转发路径（主机探针模式）。
- firewall 适配器：TLS 加密的 TCP 连接，送达部署在客户 Linux 网关或防火墙上的联动网关（旁路模式，FR-1001）。
  边缘主机只听不发、不在流量路径上，由流量路径上的设备执行封禁。签名保证指令来自本执行器且不可重放，
  TLS 校验网关证书，回复无法被中间人伪造。
"""

import asyncio
import ssl
from collections.abc import Awaitable, Callable
from pathlib import Path

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from pydantic import ValidationError

from playbook_executor.action import ActionContext, ActionError, Result
from privileged_helper.protocol import Reply, command, encode

TIMEOUT_S = 5.0  # 每条指令的往返上限（CD-04）


class HelperError(ActionError):
    pass


type Connect = Callable[[], Awaitable[tuple[asyncio.StreamReader, asyncio.StreamWriter]]]


def unix(socket_path: Path) -> Connect:
    return lambda: asyncio.open_unix_connection(str(socket_path))


def tls(address: str, ca_file: Path) -> Connect:
    """address 为 host:port；只信任 ca_file 签发的证书，且证书须与 host 相符。"""
    host, port = address.rsplit(":", 1)
    context = ssl.create_default_context(cafile=ca_file)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    return lambda: asyncio.open_connection(host, int(port), ssl=context)


class Helper:
    """privileged-helper 客户端：一次连接一条签名指令。name 写入失败原因，区分本机与联动网关。"""

    def __init__(
        self, connect: Connect, key: Ed25519PrivateKey, name: str = "privileged-helper"
    ) -> None:
        self._connect = connect
        self._key = key
        self.name = name

    async def send(self, action: str, ip: str, ttl_s: int | None = None) -> Reply:
        try:
            line = encode(command(action, ip, ttl_s), self._key)
        except ValidationError as e:
            # 指令本身不合协议（如回环、链路本地、组播地址，或超出范围的时长）：helper 同样会拒绝。按动作
            # 失败处理：否则异常穿过编排（只处理 ActionError），执行停在"执行中"且目标一直被占用；重启恢复时
            # 再次抛出，执行器反复启动失败
            reasons = "；".join(err["msg"] for err in e.errors())
            raise HelperError(f"指令不合 privileged-helper 协议：{reasons}") from e

        async def exchange() -> bytes:
            reader, writer = await self._connect()
            try:
                writer.write(line)
                await writer.drain()
                return await reader.readline()
            finally:
                writer.close()

        try:
            raw = await asyncio.wait_for(exchange(), TIMEOUT_S)
        except (OSError, TimeoutError) as e:  # ssl.SSLError 是 OSError 的子类：证书不符同样按不可达
            raise HelperError(f"{self.name} 不可达：{e!r}") from e
        try:
            reply = Reply.model_validate_json(raw)
        except ValidationError as e:
            # helper 重启或处理中崩溃时断开连接而不回复：按失败处理，不让目标一直被占用
            raise HelperError(f"{self.name} 回复为空或格式错误：{raw[:80]!r}") from e
        if not reply.ok:
            raise HelperError(reply.error or f"{self.name} 拒绝执行")
        return reply


class BlockIp:
    def __init__(self, helper: Helper, where: str = "内核防火墙") -> None:
        self._helper = helper
        self._where = where  # verify 结论中封禁所在的位置

    async def precheck(self, ctx: ActionContext) -> Result:
        # 白名单、部署模式与互斥由编排统一检查（C-BE-04）；地址合法性由 helper 协议再校验
        return Result(True)

    async def execute(self, ctx: ActionContext) -> None:
        await self._helper.send("block", str(ctx.target), ctx.ttl_s)

    async def verify(self, ctx: ActionContext) -> Result:
        reply = await self._helper.send("counters", str(ctx.target))
        if reply.expires_s is None:
            return Result(False, f"封禁规则未在{self._where}中生效")
        return Result(True, f"封禁规则已在{self._where}中生效")

    async def rollback(self, ctx: ActionContext) -> None:
        await self._helper.send("unblock", str(ctx.target))

    async def intercepted(self, ctx: ActionContext) -> int | None:
        return (await self._helper.send("counters", str(ctx.target))).packets
