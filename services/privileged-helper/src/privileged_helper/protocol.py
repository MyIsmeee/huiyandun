"""helper 指令协议（C-SEC-06、D-074）：playbook-executor 签名，privileged-helper 校验后执行。

一行一条：{"payload": <base64 指令 JSON>, "signature": <base64 Ed25519 签名>}。签名覆盖 payload 原文；
指令带时刻与随机数，helper 拒绝时间偏差超过 MAX_SKEW 或重复的指令，截获的指令无法重放。
"""

import base64
import json
import uuid
from datetime import UTC, datetime, timedelta
from ipaddress import IPv4Address, IPv6Address
from typing import Annotated, Literal

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, ValidationError, model_validator

MAX_SKEW = timedelta(seconds=30)


class ProtocolError(ValueError):
    """指令被拒绝：原因写回给调用方，不执行任何动作。"""


class Command(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    action: Literal["block", "unblock", "counters"]
    ip: IPv4Address | IPv6Address
    ttl_s: Annotated[int, Field(ge=1, le=86400)] | None = None  # C-BE-05
    ts: AwareDatetime
    nonce: str

    @model_validator(mode="after")
    def _check(self) -> "Command":
        if (self.action == "block") != (self.ttl_s is not None):
            raise ValueError("block 必须带 ttl_s，其他动作不得带")
        ip = self.ip
        if ip.is_loopback or ip.is_multicast or ip.is_unspecified or ip.is_link_local:
            raise ValueError(f"不处置非单播或本机地址 {ip}")
        return self


class Reply(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    ok: bool
    error: str | None = None
    # counters：元素仍在集合中时为其计数与剩余秒数，已不在（到期或已解封）时为 None
    packets: int | None = None
    expires_s: int | None = None


def command(action: str, ip: str, ttl_s: int | None = None) -> Command:
    return Command.model_validate(
        {
            "action": action,
            "ip": ip,
            "ttl_s": ttl_s,
            "ts": datetime.now(UTC),
            "nonce": uuid.uuid4().hex,
        }
    )


def encode(cmd: Command, key: Ed25519PrivateKey) -> bytes:
    payload = cmd.model_dump_json().encode()
    signed = {
        "payload": base64.b64encode(payload).decode(),
        "signature": base64.b64encode(key.sign(payload)).decode(),
    }
    return json.dumps(signed).encode() + b"\n"


class Verifier:
    """校验签名、时间偏差与随机数；已用随机数保留 2 × MAX_SKEW，过期的不可能再通过时间校验。"""

    def __init__(self, key: Ed25519PublicKey) -> None:
        self._key = key
        self._seen: dict[str, datetime] = {}

    def decode(self, line: bytes, now: datetime) -> Command:
        try:
            signed = json.loads(line)
            payload = base64.b64decode(signed["payload"], validate=True)
            signature = base64.b64decode(signed["signature"], validate=True)
        except (ValueError, KeyError, TypeError) as e:
            raise ProtocolError("格式错误") from e
        try:
            self._key.verify(signature, payload)
        except InvalidSignature as e:
            raise ProtocolError("签名不符") from e
        try:
            cmd = Command.model_validate_json(payload)
        except ValidationError as e:
            raise ProtocolError(f"指令非法：{e.errors()[0]['msg']}") from e
        if abs(now - cmd.ts) > MAX_SKEW:
            raise ProtocolError("时间偏差过大")
        self._seen = {n: t for n, t in self._seen.items() if now - t <= 2 * MAX_SKEW}
        if cmd.nonce in self._seen:
            raise ProtocolError("重复的指令")
        self._seen[cmd.nonce] = now
        return cmd
