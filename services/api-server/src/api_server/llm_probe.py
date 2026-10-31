"""测试连接与模型列表（FR-602、V-M6、TK-060）：转交 llm-gateway，api-server 自身不访问供应商（C-LLM-01）。

转交时附上解密后的 Key，只经 llm-net；测试结果写入供应商 last_test，探测到的能力写入 structured_output。
开启全局禁止公网供应商时，不向公网地址发送任何请求（D-085）。
"""

import logging
from typing import Any

import httpx2
from cryptography.exceptions import InvalidTag
from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select, update

from api_server.auth import require
from api_server.llm import block_public, classify, normalize, providers, unseal
from py_contracts.api import ModelDiscovery, ModelList, ProviderTestResult

log = logging.getLogger(__name__)

# 测试连接最多依次发出：/models（含补 /v1 重试）2 次、结构化输出 2 次，各受供应商超时约束
PROBE_CALLS, MODELS_CALLS, MARGIN_S = 4, 2, 5

router = APIRouter(prefix="/api/llm", dependencies=[Depends(require("admin"))])


async def forward(request: Request, path: str, target: dict[str, Any], calls: int) -> Any:
    try:
        res = await request.app.state.llm_gateway.post(
            path, json=target, timeout=target["timeout_s"] * calls + MARGIN_S
        )
    except httpx2.HTTPError as e:
        log.warning("llm.gateway_unreachable", extra={"path": path, "error": type(e).__name__})
        raise HTTPException(502, "模型网关暂不可达") from e
    if res.status_code == 502:  # 供应商出错：网关给出"原因；改法"
        raise HTTPException(502, res.json()["message"])
    if res.is_error:
        log.warning("llm.gateway_error", extra={"path": path, "status": res.status_code})
        raise HTTPException(502, "模型网关出错")
    return res.json()


async def ensure_allowed(request: Request, network: str) -> None:
    if network != "public":
        return
    async with request.app.state.engine.connect() as conn:
        if await block_public(conn):
            raise HTTPException(409, "已开启全局禁止公网供应商，不向公网地址发送请求")


async def target_of(request: Request, provider_id: str) -> dict[str, Any]:
    async with request.app.state.engine.connect() as conn:
        row = (
            (await conn.execute(select(providers).where(providers.c.id == provider_id)))
            .mappings()
            .first()
        )
    if row is None:
        raise HTTPException(404, "供应商不存在")
    await ensure_allowed(request, row["network"])  # 管理员改判过的以改判为准
    api_key = None
    if row["api_key_enc"] is not None:
        try:
            api_key = unseal(request.app.state.config.llm_key_file, row["api_key_enc"])
        except InvalidTag as e:
            raise HTTPException(400, "已存的 Key 无法解密（密钥文件已更换），请重新填写 Key") from e
    return {
        "base_url": row["base_url"],
        "api_key": api_key,
        "model": row["model"],
        "timeout_s": row["timeout_s"],
    }


@router.post("/providers/{provider_id}/test")
async def test_provider(provider_id: str, request: Request) -> ProviderTestResult:
    reply = await forward(
        request, "/internal/probe", await target_of(request, provider_id), PROBE_CALLS
    )
    result = ProviderTestResult.model_validate(reply["result"])
    values: dict[str, Any] = {"last_test": result.model_dump(mode="json")}
    if reply["structured_output"] is not None:
        values["structured_output"] = reply["structured_output"]
    # 探测可能持续数十秒，不在探测期间持有行锁；供应商在此期间被删除时不写入
    async with request.app.state.engine.begin() as conn:
        await conn.execute(update(providers).where(providers.c.id == provider_id).values(values))
    return result


@router.get("/providers/{provider_id}/models")
async def list_provider_models(provider_id: str, request: Request) -> ModelList:
    target = await target_of(request, provider_id)
    return ModelList.model_validate(
        await forward(request, "/internal/models", target, MODELS_CALLS)
    )


@router.post("/models")
async def discover_models(body: ModelDiscovery, request: Request) -> ModelList:
    base_url = normalize(body.base_url)
    await ensure_allowed(request, classify(base_url))
    target = {
        "base_url": base_url,
        "api_key": body.api_key.get_secret_value() if body.api_key else None,
        "timeout_s": body.timeout_s or 60,  # 显式传 null 时取契约默认值
    }
    return ModelList.model_validate(
        await forward(request, "/internal/models", target, MODELS_CALLS)
    )
