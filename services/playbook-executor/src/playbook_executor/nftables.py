"""nftables 适配器的 block_ip 动作（TK-051、D-074）：经 privileged-helper 的签名指令封禁源地址。

封禁写入内核集合并带超时，到期由内核解除；verify 列出集合确认元素已生效（D-072）。
"""

import asyncio
from pathlib import Path

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from playbook_executor.action import ActionContext, Result
from privileged_helper.protocol import Reply, command, encode

TIMEOUT_S = 5.0  # 每条指令的往返上限（CD-04）


class HelperError(RuntimeError):
    pass


class Helper:
    """privileged-helper 客户端：一次连接一条签名指令。"""

    def __init__(self, socket_path: Path, key: Ed25519PrivateKey) -> None:
        self._socket = socket_path
        self._key = key

    async def send(self, action: str, ip: str, ttl_s: int | None = None) -> Reply:
        line = encode(command(action, ip, ttl_s), self._key)

        async def exchange() -> bytes:
            reader, writer = await asyncio.open_unix_connection(str(self._socket))
            try:
                writer.write(line)
                await writer.drain()
                return await reader.readline()
            finally:
                writer.close()

        try:
            raw = await asyncio.wait_for(exchange(), TIMEOUT_S)
        except (OSError, TimeoutError) as e:
            raise HelperError(f"privileged-helper 不可达：{e!r}") from e
        reply = Reply.model_validate_json(raw)
        if not reply.ok:
            raise HelperError(reply.error or "privileged-helper 拒绝执行")
        return reply


class BlockIp:
    def __init__(self, helper: Helper) -> None:
        self._helper = helper

    async def precheck(self, ctx: ActionContext) -> Result:
        # 白名单、部署模式与互斥由编排统一检查（C-BE-04）；地址合法性由 helper 协议再校验
        return Result(True)

    async def execute(self, ctx: ActionContext) -> None:
        await self._helper.send("block", str(ctx.target), ctx.ttl_s)

    async def verify(self, ctx: ActionContext) -> Result:
        reply = await self._helper.send("counters", str(ctx.target))
        if reply.expires_s is None:
            return Result(False, "封禁规则未在内核防火墙中生效")
        return Result(True, "封禁规则已在内核防火墙中生效")

    async def rollback(self, ctx: ActionContext) -> None:
        await self._helper.send("unblock", str(ctx.target))

    async def intercepted(self, ctx: ActionContext) -> int | None:
        return (await self._helper.send("counters", str(ctx.target))).packets
