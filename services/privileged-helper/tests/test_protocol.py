"""签名指令协议（C-SEC-06）：只有正确签名、时间与随机数有效、参数合法的指令才被接受。"""

import base64
import json
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from privileged_helper.protocol import ProtocolError, Verifier, command, encode

KEY = Ed25519PrivateKey.generate()


def verifier() -> Verifier:
    return Verifier(KEY.public_key())


def test_signed_command_accepted() -> None:
    cmd = command("block", "172.30.0.100", 150)
    assert verifier().decode(encode(cmd, KEY), datetime.now(UTC)) == cmd


def test_other_key_rejected() -> None:
    line = encode(command("unblock", "172.30.0.100"), Ed25519PrivateKey.generate())
    with pytest.raises(ProtocolError, match="签名不符"):
        verifier().decode(line, datetime.now(UTC))


def test_tampered_payload_rejected() -> None:
    signed = json.loads(encode(command("block", "172.30.0.100", 150), KEY))
    payload = json.loads(base64.b64decode(signed["payload"]))
    payload["ip"] = "172.30.0.1"  # 改封禁目标
    signed["payload"] = base64.b64encode(json.dumps(payload).encode()).decode()
    with pytest.raises(ProtocolError, match="签名不符"):
        verifier().decode(json.dumps(signed).encode(), datetime.now(UTC))


def test_stale_command_rejected() -> None:
    line = encode(command("counters", "172.30.0.100"), KEY)
    with pytest.raises(ProtocolError, match="时间偏差"):
        verifier().decode(line, datetime.now(UTC) + timedelta(seconds=31))


def test_replayed_command_rejected() -> None:
    v, line = verifier(), encode(command("block", "172.30.0.100", 150), KEY)
    v.decode(line, datetime.now(UTC))
    with pytest.raises(ProtocolError, match="重复"):
        v.decode(line, datetime.now(UTC))


def signed(fields: dict[str, Any]) -> bytes:
    payload = json.dumps(
        {"ts": datetime.now(UTC).isoformat(), "nonce": "n1", "ttl_s": None} | fields
    ).encode()
    return json.dumps(
        {
            "payload": base64.b64encode(payload).decode(),
            "signature": base64.b64encode(KEY.sign(payload)).decode(),
        }
    ).encode()


@pytest.mark.parametrize(
    "fields",
    [
        {"action": "block", "ip": "172.30.0.100"},  # 缺 ttl_s
        {"action": "unblock", "ip": "172.30.0.100", "ttl_s": 60},
        {"action": "block", "ip": "172.30.0.100", "ttl_s": 86401},  # C-BE-05 上限
        {"action": "block", "ip": "127.0.0.1", "ttl_s": 60},
        {"action": "block", "ip": "224.0.0.1", "ttl_s": 60},
        {"action": "flush", "ip": "172.30.0.100"},
        {"action": "block", "ip": "172.30.0.100; rm -rf /", "ttl_s": 60},
        {"action": "block", "ip": "172.30.0.100", "ttl_s": 60, "table": "x"},  # 未知字段
    ],
)
def test_invalid_command_rejected(fields: dict[str, Any]) -> None:
    with pytest.raises(ProtocolError, match="指令非法"):
        verifier().decode(signed(fields), datetime.now(UTC))


@pytest.mark.parametrize("line", [b"not json", b"{}", b'{"payload": "!!", "signature": ""}'])
def test_malformed_line_rejected(line: bytes) -> None:
    with pytest.raises(ProtocolError, match="格式错误"):
        verifier().decode(line, datetime.now(UTC))
