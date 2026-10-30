"""套接字服务：一次连接一条签名指令，回一行结果；被拒与执行失败都写回原因。"""

import asyncio
from ipaddress import IPv4Address, IPv6Address
from pathlib import Path

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

from privileged_helper.nft import Nft, NftError
from privileged_helper.protocol import Reply, command, encode
from privileged_helper.server import HelperConfig, start

KEY = Ed25519PrivateKey.generate()

type Ip = IPv4Address | IPv6Address


class FakeNft(Nft):
    def __init__(self) -> None:
        self.blocked: dict[str, int] = {}

    async def setup(self) -> None:
        pass

    async def block(self, ip: Ip, ttl_s: int) -> None:
        if str(ip) == "198.51.100.9":
            raise NftError("Operation not permitted")
        self.blocked[str(ip)] = ttl_s

    async def unblock(self, ip: Ip) -> None:
        self.blocked.pop(str(ip), None)

    async def counters(self, ip: Ip) -> tuple[int, int] | None:
        return (60, 121) if str(ip) in self.blocked else None


async def send(path: Path, line: bytes) -> Reply:
    reader, writer = await asyncio.open_unix_connection(str(path))
    writer.write(line)
    await writer.drain()
    reply = Reply.model_validate_json(await reader.readline())
    writer.close()
    return reply


def test_block_counters_unblock_and_rejections(tmp_path: Path) -> None:
    key_file = tmp_path / "helper.pub"
    key_file.write_bytes(
        KEY.public_key().public_bytes(Encoding.PEM, PublicFormat.SubjectPublicKeyInfo)
    )
    config = HelperConfig(socket_path=tmp_path / "helper.sock", public_key_file=key_file)
    nft = FakeNft()

    async def scenario() -> list[Reply]:
        server = await start(config, nft)
        sock = config.socket_path
        replies = [
            await send(sock, encode(command("block", "172.30.0.100", 150), KEY)),
            await send(sock, encode(command("counters", "172.30.0.100"), KEY)),
            await send(sock, encode(command("unblock", "172.30.0.100"), KEY)),
            await send(sock, encode(command("counters", "172.30.0.100"), KEY)),
            await send(
                sock, encode(command("block", "172.30.0.101", 150), Ed25519PrivateKey.generate())
            ),
            await send(sock, encode(command("block", "198.51.100.9", 150), KEY)),
        ]
        server.close()
        return replies

    replies = asyncio.run(scenario())
    assert replies[:4] == [
        Reply(ok=True),
        Reply(ok=True, packets=60, expires_s=121),
        Reply(ok=True),
        Reply(ok=True),  # 已解封：没有计数
    ]
    assert replies[4] == Reply(ok=False, error="签名不符")
    assert not replies[5].ok and "not permitted" in (replies[5].error or "")
    assert nft.blocked == {}
