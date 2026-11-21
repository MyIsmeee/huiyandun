"""privileged-helper（C-SEC-06、D-074）：Unix 域套接字上一次连接一条签名指令，执行后回一行结果。

只有三种动作（封禁、解封、读计数），参数经协议校验；不接受签名不符、过期或重复的指令。

另可作为外部防火墙联动网关（旁路部署，FR-1001）：部署在客户的 Linux 网关或防火墙上，在 TLS 加密的 TCP 端口上
接受同一协议的签名指令，封禁作用于该设备的转发路径。边缘主机只听不发、不在流量路径上时，由它真正拦住攻击。
"""

import asyncio
import logging
import os
import ssl
from datetime import UTC, datetime
from pathlib import Path

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from cryptography.hazmat.primitives.serialization import load_pem_public_key
from pydantic import Field, model_validator

from privileged_helper.nft import Nft, NftError
from privileged_helper.protocol import Command, ProtocolError, Reply, Verifier
from py_common.config import ServiceConfig, load_config
from py_common.log import configure_logging

READ_TIMEOUT_S = 5.0  # 等待一条指令的上限（CD-04）
MAX_LINE = 4096

log = logging.getLogger(__name__)


class HelperConfig(ServiceConfig):
    socket_path: Path = Field(
        Path("/run/hyd-helper/helper.sock"),
        description="Unix 域套接字，位于只与 playbook-executor 共享的卷中",
    )
    public_key_file: Path = Field(
        Path("/run/secrets/helper_public_key"),
        description="playbook-executor 签名密钥对应的 Ed25519 公钥（PEM）",
    )
    tcp_listen: str | None = Field(
        None,
        pattern=r"^[^\s:]+:[0-9]{1,5}$",
        description="作为外部防火墙联动网关时监听的 TCP 地址，如 0.0.0.0:7443；不设则只监听套接字",
    )
    tls_cert_file: Path | None = Field(
        None, description="联动网关的 TLS 证书链（PEM）；监听 TCP 时必填，执行器据此确认网关身份"
    )
    tls_key_file: Path | None = Field(None, description="联动网关 TLS 证书的私钥（PEM）")

    @model_validator(mode="after")
    def _tls_required(self) -> "HelperConfig":
        # 签名只保证指令来自执行器；回复须经 TLS 保护，否则中间人可伪造"已封禁"
        if self.tcp_listen and not (self.tls_cert_file and self.tls_key_file):
            raise ValueError("监听 TCP 时须同时配置 tls_cert_file 与 tls_key_file")
        return self


async def execute(nft: Nft, cmd: Command) -> Reply:
    if cmd.action == "block":
        assert cmd.ttl_s is not None  # 协议已校验
        await nft.block(cmd.ip, cmd.ttl_s)
        return Reply(ok=True)
    if cmd.action == "unblock":
        await nft.unblock(cmd.ip)
        return Reply(ok=True)
    found = await nft.counters(cmd.ip)
    if found is None:
        return Reply(ok=True)
    packets, expires_s = found
    return Reply(ok=True, packets=packets, expires_s=expires_s)


async def handle(
    verifier: Verifier, nft: Nft, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
) -> None:
    try:
        line = await asyncio.wait_for(reader.readline(), READ_TIMEOUT_S)
        cmd = verifier.decode(line[:MAX_LINE], datetime.now(UTC))
        reply = await execute(nft, cmd)
        log.info(
            "helper.executed",
            extra={"action": cmd.action, "ip": str(cmd.ip), "ttl_s": cmd.ttl_s},
        )
    except ProtocolError as e:
        log.warning("helper.rejected", extra={"error": str(e)})
        reply = Reply(ok=False, error=str(e))
    except (NftError, TimeoutError) as e:
        log.error("helper.failed", extra={"error": repr(e)})
        reply = Reply(ok=False, error=f"执行失败：{e}")
    writer.write(reply.model_dump_json().encode() + b"\n")
    await writer.drain()
    writer.close()


def load_key(path: Path) -> Ed25519PublicKey:
    key = load_pem_public_key(path.read_bytes())
    if not isinstance(key, Ed25519PublicKey):
        raise TypeError(f"{path} 不是 Ed25519 公钥")
    return key


def tls_context(config: HelperConfig) -> ssl.SSLContext:
    assert config.tls_cert_file is not None and config.tls_key_file is not None  # 配置已校验
    context = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.load_cert_chain(config.tls_cert_file, config.tls_key_file)
    return context


async def start(config: HelperConfig, nft: Nft) -> list[asyncio.Server]:
    """建好封禁表并开始监听；返回时套接字（及联动网关的 TCP 端口）已可连接。两者共用同一校验器，
    随机数在两条入口间同样不可重放。"""
    verifier = Verifier(load_key(config.public_key_file))
    await nft.setup()
    config.socket_path.unlink(missing_ok=True)
    servers = [
        await asyncio.start_unix_server(
            lambda r, w: handle(verifier, nft, r, w), path=str(config.socket_path)
        )
    ]
    # 卷只挂载给 helper 与 executor；executor 以非 root 运行，套接字须可写。鉴权靠签名
    os.chmod(config.socket_path, 0o666)
    log.info("helper.started", extra={"socket": str(config.socket_path)})
    if config.tcp_listen:
        host, port = config.tcp_listen.rsplit(":", 1)
        servers.append(
            await asyncio.start_server(
                lambda r, w: handle(verifier, nft, r, w),
                host,
                int(port),
                ssl=tls_context(config),
                ssl_handshake_timeout=READ_TIMEOUT_S,
            )
        )
        log.info("helper.gateway_started", extra={"listen": config.tcp_listen})
    return servers


async def serve(config: HelperConfig) -> None:
    servers = await start(config, Nft())
    await asyncio.gather(*(s.serve_forever() for s in servers))


def main() -> None:
    """hyd-helper：常驻，等待签名指令。"""
    config = load_config(HelperConfig)
    configure_logging("privileged-helper", config.log_level)
    asyncio.run(serve(config))
