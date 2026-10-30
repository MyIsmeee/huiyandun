"""block_ip 动作：经真实的 helper 套接字服务（nft 以假实现代替）执行四接口与拦截证据。"""

import asyncio
from collections.abc import Awaitable, Callable
from ipaddress import IPv4Address, IPv6Address, ip_address
from pathlib import Path

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

from playbook_executor.action import ActionContext, Result
from playbook_executor.nftables import BlockIp, Helper, HelperError
from privileged_helper.nft import Nft, NftError
from privileged_helper.server import HelperConfig, start

KEY = Ed25519PrivateKey.generate()
CTX = ActionContext(target=ip_address("172.30.0.100"), ttl_s=150, params={})

type Ip = IPv4Address | IPv6Address


class FakeNft(Nft):
    def __init__(self, fail: bool = False) -> None:
        self.blocked: dict[str, int] = {}
        self.fail = fail

    async def setup(self) -> None:
        pass

    async def block(self, ip: Ip, ttl_s: int) -> None:
        if self.fail:
            raise NftError("Operation not permitted")
        self.blocked[str(ip)] = ttl_s

    async def unblock(self, ip: Ip) -> None:
        self.blocked.pop(str(ip), None)

    async def counters(self, ip: Ip) -> tuple[int, int] | None:
        return (60, 121) if str(ip) in self.blocked else None


def with_helper(tmp_path: Path, nft: Nft, scenario: Callable[[BlockIp], Awaitable[None]]) -> None:
    key_file = tmp_path / "helper.pub"
    key_file.write_bytes(
        KEY.public_key().public_bytes(Encoding.PEM, PublicFormat.SubjectPublicKeyInfo)
    )
    config = HelperConfig(socket_path=tmp_path / "helper.sock", public_key_file=key_file)

    async def main() -> None:
        server = await start(config, nft)
        try:
            await scenario(BlockIp(Helper(config.socket_path, KEY)))
        finally:
            server.close()

    asyncio.run(main())


def test_block_verify_evidence_rollback(tmp_path: Path) -> None:
    nft = FakeNft()
    seen: list[object] = []

    async def scenario(action: BlockIp) -> None:
        seen.append(await action.precheck(CTX))
        await action.execute(CTX)
        seen.append(await action.verify(CTX))
        seen.append(await action.intercepted(CTX))
        await action.rollback(CTX)
        seen.append(await action.verify(CTX))
        seen.append(await action.intercepted(CTX))

    with_helper(tmp_path, nft, scenario)
    assert seen == [
        Result(True),
        Result(True, "封禁规则已在内核防火墙中生效"),
        60,
        Result(False, "封禁规则未在内核防火墙中生效"),
        None,
    ]
    assert nft.blocked == {}


def test_helper_failure_raised_with_reason(tmp_path: Path) -> None:
    async def scenario(action: BlockIp) -> None:
        with pytest.raises(HelperError, match="not permitted"):
            await action.execute(CTX)

    with_helper(tmp_path, FakeNft(fail=True), scenario)


def test_helper_unreachable_raised(tmp_path: Path) -> None:
    action = BlockIp(Helper(tmp_path / "missing.sock", KEY))
    with pytest.raises(HelperError, match="不可达"):
        asyncio.run(action.execute(CTX))
