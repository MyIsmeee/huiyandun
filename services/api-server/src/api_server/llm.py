"""模型供应商管理（FR-601～FR-605、TK-060）：增删改、排序、全局禁止公网。

API Key 只写不读：库中只存 AES-256-GCM 密文与末 4 位，响应与审计只含末 4 位（C-ST-03、C-LLM-15）。
公网供应商新增即停用，由内网改为公网时停用，全局禁止公网时不可启用（G-02、FR-604）。
每项变更与审计同一事务写入（G-13）。
"""

import base64
import os
import uuid
from datetime import UTC, datetime
from functools import cache
from ipaddress import ip_address, ip_network
from pathlib import Path
from typing import Annotated, Any, Literal
from urllib.parse import urlsplit

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    Integer,
    LargeBinary,
    MetaData,
    Table,
    Text,
    delete,
    func,
    insert,
    select,
    update,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.asyncio import AsyncConnection

from api_server.audit import record
from api_server.auth import Principal, require
from py_contracts.api import (
    LlmProvider,
    LlmProviderCreate,
    LlmProviderList,
    LlmProviderUpdate,
    LlmSettings,
    ProviderOrder,
)

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


def view(row: Any) -> LlmProvider:
    return LlmProvider.model_validate(
        {name: row[name] for name in LlmProvider.model_fields if name != "order"}
        | {"order": row["position"]}
    )


def audit_view(provider: LlmProvider) -> dict[str, Any]:
    return provider.model_dump(mode="json", exclude={"last_test"})


async def block_public(conn: AsyncConnection) -> bool:
    return bool(await conn.scalar(select(settings.c.block_public)))


async def locked(conn: AsyncConnection, provider_id: str) -> Any:
    row = (
        (
            await conn.execute(
                select(providers).where(providers.c.id == provider_id).with_for_update()
            )
        )
        .mappings()
        .first()
    )
    if row is None:
        raise HTTPException(404, "供应商不存在")
    return row


router = APIRouter(prefix="/api/llm")
Admin = Annotated[Principal, Depends(require("admin"))]


@router.get("/providers", dependencies=[Depends(require("admin"))])
async def list_providers(request: Request) -> LlmProviderList:
    async with request.app.state.engine.connect() as conn:
        rows = (await conn.execute(select(providers).order_by(providers.c.position))).mappings()
        return LlmProviderList(items=[view(r) for r in rows])


@router.post("/providers", status_code=201)
async def create_provider(
    body: LlmProviderCreate, request: Request, principal: Admin
) -> LlmProvider:
    base_url = normalize(body.base_url)
    auto = classify(base_url)
    network = body.network.root if body.network else auto
    now = datetime.now(UTC)
    values = {
        "id": f"llm-{uuid.uuid4().hex[:12]}",
        "name": body.name,
        "preset": body.preset.root,
        "base_url": base_url,
        "model": body.model,
        "network": network,
        "network_overridden": network != auto,
        "structured_output": None,
        "timeout_s": body.timeout_s or 60,  # 显式传 null 时取契约默认值
        "enabled": network == "internal",  # 公网新增即停用（G-02）
        "last_test": None,
        "created_at": now,
        "updated_at": now,
    } | key_columns(
        request.app.state.config.llm_key_file,
        body.api_key.get_secret_value() if body.api_key else "",
    )
    async with request.app.state.engine.begin() as conn:
        values["position"] = await conn.scalar(
            select(func.coalesce(func.max(providers.c.position) + 1, 0))
        )
        await conn.execute(insert(providers).values(values))
        provider = view(values)
        await record(
            conn,
            actor=principal.username,
            action="llm.provider_created",
            target=provider.id,
            before=None,
            after=audit_view(provider),
            request_id=request.state.request_id,
        )
    return provider


@router.patch("/providers/{provider_id}")
async def update_provider(
    provider_id: str, body: LlmProviderUpdate, request: Request, principal: Admin
) -> LlmProvider:
    changes = body.model_dump(mode="json", exclude_unset=True, exclude_none=True)
    async with request.app.state.engine.begin() as conn:
        row = await locked(conn, provider_id)
        values: dict[str, Any] = {
            k: changes[k] for k in ("name", "preset", "model", "timeout_s") if k in changes
        }
        base_url = normalize(changes["base_url"]) if "base_url" in changes else row["base_url"]
        auto = classify(base_url)
        if "network" in changes:
            network, overridden = changes["network"], changes["network"] != auto
        elif "base_url" in changes:
            network, overridden = auto, False
        else:
            network, overridden = row["network"], row["network_overridden"]
        enabled = changes.get("enabled", row["enabled"])
        # 由内网改为公网时停用，除非本次请求经前端确认后显式启用（G-02）
        if (
            network == "public"
            and row["network"] == "internal"
            and changes.get("enabled") is not True
        ):
            enabled = False
        if network == "public" and enabled and await block_public(conn):
            raise HTTPException(409, "已开启全局禁止公网供应商，不能启用公网供应商")
        if body.api_key is not None:
            values |= key_columns(
                request.app.state.config.llm_key_file, body.api_key.get_secret_value()
            )
        # 地址、Key、模型变了，上次测试结果与探测到的能力不再可信
        if (
            base_url != row["base_url"]
            or "api_key_enc" in values
            or values.get("model", row["model"]) != row["model"]
        ):
            values |= {"last_test": None, "structured_output": None}
        values |= {
            "base_url": base_url,
            "network": network,
            "network_overridden": overridden,
            "enabled": enabled,
            "updated_at": datetime.now(UTC),
        }
        await conn.execute(update(providers).where(providers.c.id == provider_id).values(values))
        before, after = view(row), view(dict(row) | values)
        await record(
            conn,
            actor=principal.username,
            action="llm.provider_updated",
            target=provider_id,
            before=audit_view(before),
            after=audit_view(after),
            request_id=request.state.request_id,
        )
    return after


@router.delete("/providers/{provider_id}", status_code=204)
async def delete_provider(provider_id: str, request: Request, principal: Admin) -> Response:
    async with request.app.state.engine.begin() as conn:
        row = await locked(conn, provider_id)
        await conn.execute(delete(providers).where(providers.c.id == provider_id))
        await conn.execute(
            update(providers)
            .where(providers.c.position > row["position"])
            .values(position=providers.c.position - 1)
        )
        await record(
            conn,
            actor=principal.username,
            action="llm.provider_deleted",
            target=provider_id,
            before=audit_view(view(row)),
            after=None,
            request_id=request.state.request_id,
        )
    return Response(status_code=204)


@router.put("/providers/order", status_code=204)
async def reorder_providers(body: ProviderOrder, request: Request, principal: Admin) -> Response:
    async with request.app.state.engine.begin() as conn:
        current = (
            await conn.scalars(
                select(providers.c.id).order_by(providers.c.position).with_for_update()
            )
        ).all()
        if len(body.provider_ids) != len(current) or set(body.provider_ids) != set(current):
            raise HTTPException(400, "provider_ids 须恰好包含全部供应商，且不重复")
        for position, provider_id in enumerate(body.provider_ids):
            await conn.execute(
                update(providers).where(providers.c.id == provider_id).values(position=position)
            )
        await record(
            conn,
            actor=principal.username,
            action="llm.providers_reordered",
            target="llm_providers",
            before={"provider_ids": list(current)},
            after={"provider_ids": body.provider_ids},
            request_id=request.state.request_id,
        )
    return Response(status_code=204)


@router.get("/settings", dependencies=[Depends(require("admin"))])
async def get_settings(request: Request) -> LlmSettings:
    async with request.app.state.engine.connect() as conn:
        return LlmSettings(block_public=await block_public(conn))


@router.put("/settings")
async def update_settings(body: LlmSettings, request: Request, principal: Admin) -> LlmSettings:
    async with request.app.state.engine.begin() as conn:
        before = await block_public(conn)
        await conn.execute(update(settings).values(block_public=body.block_public))
        disabled: list[str] = []
        if body.block_public:
            disabled = list(
                await conn.scalars(
                    update(providers)
                    .where(providers.c.network == "public", providers.c.enabled)
                    .values(enabled=False, updated_at=datetime.now(UTC))
                    .returning(providers.c.id)
                )
            )
        await record(
            conn,
            actor=principal.username,
            action="llm.settings_updated",
            target="llm_settings",
            before={"block_public": before},
            after={"block_public": body.block_public, "disabled_provider_ids": disabled},
            request_id=request.state.request_id,
        )
    return body
