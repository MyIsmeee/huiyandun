"""模型供应商管理（FR-601～FR-605、TK-060）：表定义、网络位置判定、地址纠正与 API Key 加密。

API Key 只写不读：库中只存 AES-256-GCM 密文与末 4 位，响应与审计只含末 4 位（C-ST-03、C-LLM-15）。
"""

import base64
import os
from functools import cache
from ipaddress import ip_address, ip_network
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlsplit

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from fastapi import HTTPException
from sqlalchemy import Boolean, Column, DateTime, Integer, LargeBinary, MetaData, Table, Text
from sqlalchemy.dialects.postgresql import JSONB

# C-LLM-13：回环、私有网段、链路本地为内网，其余（含所有域名）为公网
INTERNAL_NETWORKS = [
    ip_network(n)
    for n in (
        "127.0.0.0/8",
        "::1/128",
        "10.0.0.0/8",
        "172.16.0.0/12",
        "192.168.0.0/16",
        "fc00::/7",
        "169.254.0.0/16",
        "fe80::/10",
    )
]
# 误把完整接口地址粘进 base URL 时去掉（D-084，借鉴 cc-switch）
ENDPOINT_SUFFIXES = ("/chat/completions", "/completions", "/models")
NONCE_BYTES = 12

# 表结构由迁移 0005 定义
metadata = MetaData()
providers = Table(
    "llm_providers",
    metadata,
    Column("id", Text, primary_key=True),
    Column("name", Text),
    Column("preset", Text),
    Column("base_url", Text),
    Column("api_key_enc", LargeBinary),
    Column("api_key_last4", Text),
    Column("model", Text),
    Column("network", Text),
    Column("network_overridden", Boolean),
    Column("structured_output", Text),
    Column("timeout_s", Integer),
    Column("enabled", Boolean),
    Column("position", Integer),
    Column("last_test", JSONB(none_as_null=True)),
    Column("created_at", DateTime(timezone=True)),
    Column("updated_at", DateTime(timezone=True)),
)
settings = Table("llm_settings", metadata, Column("block_public", Boolean))


def classify(base_url: str) -> Literal["internal", "public"]:
    try:
        addr = ip_address(urlsplit(base_url).hostname or "")
    except ValueError:
        return "public"  # 域名一律按公网
    return "internal" if any(addr in n for n in INTERNAL_NETWORKS) else "public"


def normalize(base_url: str) -> str:
    url = base_url.strip().rstrip("/")
    for suffix in ENDPOINT_SUFFIXES:
        url = url.removesuffix(suffix)
    url = url.rstrip("/")
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise HTTPException(400, "地址须为 http:// 或 https:// 开头的 OpenAI 兼容地址")
    return url


@cache
def _key(path: Path) -> bytes:
    key = base64.b64decode(path.read_text(encoding="utf-8").strip())
    if len(key) != 32:
        raise ValueError(f"{path} 须为 32 字节密钥的 base64（AES-256-GCM）")
    return key


def seal(key_file: Path, plaintext: str) -> bytes:
    nonce = os.urandom(NONCE_BYTES)
    return nonce + AESGCM(_key(key_file)).encrypt(nonce, plaintext.encode(), None)


def unseal(key_file: Path, blob: bytes) -> str:
    return AESGCM(_key(key_file)).decrypt(blob[:NONCE_BYTES], blob[NONCE_BYTES:], None).decode()


def key_columns(key_file: Path, api_key: str) -> dict[str, Any]:
    """空串表示清除 Key。"""
    if not api_key:
        return {"api_key_enc": None, "api_key_last4": None}
    return {"api_key_enc": seal(key_file, api_key), "api_key_last4": api_key[-4:]}
