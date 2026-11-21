"""套接字服务：一次连接一条签名指令，回一行结果；被拒与执行失败都写回原因。
联动网关：同一协议经 TLS 加密的 TCP 端口送达，与套接字共用防重放。"""

import asyncio
import ssl
from collections.abc import Callable
from ipaddress import IPv4Address, IPv6Address
from pathlib import Path

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from pydantic import ValidationError

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
        (server,) = await start(config, nft)
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


def test_gateway_over_tls_shares_replay_protection(
    tmp_path: Path, tls_files: Callable[[Path], tuple[Path, Path]]
) -> None:
    key_file = tmp_path / "helper.pub"
    key_file.write_bytes(
        KEY.public_key().public_bytes(Encoding.PEM, PublicFormat.SubjectPublicKeyInfo)
    )
    cert_file, tls_key = tls_files(tmp_path)
    config = HelperConfig(
        socket_path=tmp_path / "helper.sock",
        public_key_file=key_file,
        tcp_listen="127.0.0.1:0",
        tls_cert_file=cert_file,
        tls_key_file=tls_key,
    )
    nft = FakeNft()
    trusted = ssl.create_default_context(cafile=cert_file)

    async def over_tls(port: int, line: bytes) -> Reply:
        reader, writer = await asyncio.open_connection(
            "127.0.0.1", port, ssl=trusted, server_hostname="localhost"
        )
        writer.write(line)
        await writer.drain()
        reply = Reply.model_validate_json(await reader.readline())
        writer.close()
        return reply

    async def scenario() -> tuple[list[Reply], bool]:
        servers = await start(config, nft)
        port = servers[1].sockets[0].getsockname()[1]
        line = encode(command("block", "172.30.0.100", 150), KEY)
        replies = [
            await over_tls(port, line),
            await send(config.socket_path, line),  # 同一条指令换入口重放
            await over_tls(port, encode(command("counters", "172.30.0.100"), KEY)),
        ]
        # 不信任网关证书的客户端握手失败，拿不到（也伪造不了）回复
        try:
            await asyncio.open_connection("127.0.0.1", port, ssl=ssl.create_default_context())
            rejected = False
        except ssl.SSLError:
            rejected = True
        for server in servers:
            server.close()
        return replies, rejected

    replies, rejected = asyncio.run(scenario())
    assert replies == [
        Reply(ok=True),
        Reply(ok=False, error="重复的指令"),
        Reply(ok=True, packets=60, expires_s=121),
    ]
    assert rejected
    assert nft.blocked == {"172.30.0.100": 150}


def test_gateway_requires_tls(tmp_path: Path) -> None:
    with pytest.raises(ValidationError, match="tls_cert_file"):
        HelperConfig(public_key_file=tmp_path / "helper.pub", tcp_listen="0.0.0.0:7443")
