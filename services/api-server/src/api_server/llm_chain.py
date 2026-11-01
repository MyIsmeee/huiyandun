"""调用链接入（TK-062）：把已启用供应商（按故障转移顺序、Key 已解密）连同证据转交 llm-gateway，
api-server 自身不访问供应商（C-LLM-01）。

无输出时给出模板原因（FR-502）；审计与当日用量由调用方在业务事务中写入（G-13、D-084）。
"""

import logging
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

import httpx2
from cryptography.exceptions import InvalidTag
from fastapi import Request
from sqlalchemy import case, select, update
from sqlalchemy.ext.asyncio import AsyncConnection

from api_server.audit import record
from api_server.llm import providers, unseal

log = logging.getLogger(__name__)

# 网关任务总时限（deploy/configs/llm-tasks.yaml 的 deadline_s，SC-05）加余量
DEADLINE_S, MARGIN_S = 60, 5


@dataclass
class Outcome:
    output: dict[str, Any] | None
    unverified: list[str]
    provider: Any  # 成功的供应商行，无输出时为 None
    attempts: list[dict[str, Any]]
    reason: str | None  # 无输出时模板报告的原因
    networks: dict[str, str]  # 供应商 ID → 网络位置，供审计


def _skipped(provider_id: str, reason: str) -> dict[str, Any]:
    return {
        "provider_id": provider_id,
        "outcome": "skipped",
        "reason": reason,
        "latency_ms": None,
        "tokens": 0,
        "redacted": False,
    }


async def invoke(request: Request, task: str, data: dict[str, Any]) -> Outcome:
    state = request.app.state
    async with state.engine.connect() as conn:
        rows = (
            (
                await conn.execute(
                    select(providers).where(providers.c.enabled).order_by(providers.c.position)
                )
            )
            .mappings()
            .all()
        )
    by_id = {r["id"]: r for r in rows}
    networks = {r["id"]: r["network"] for r in rows}
    if not rows:
        return Outcome(None, [], None, [], "未启用任何模型供应商", networks)
    targets, attempts = [], []
    for r in rows:
        try:
            key = unseal(state.config.llm_key_file, r["api_key_enc"]) if r["api_key_enc"] else None
        except InvalidTag:
            attempts.append(_skipped(r["id"], "已存的 Key 无法解密"))
            continue
        targets.append(
            {
                "id": r["id"],
                "name": r["name"],
                "base_url": r["base_url"],
                "api_key": key,
                "model": r["model"],
                "timeout_s": r["timeout_s"],
                "network": r["network"],
                "structured_output": r["structured_output"],
            }
        )
    if targets:
        body = {"task": task, "data": data, "providers": targets}
        try:
            res = await state.llm_gateway.post(
                "/internal/invoke", json=body, timeout=DEADLINE_S + MARGIN_S
            )
            res.raise_for_status()
        except httpx2.HTTPError as e:
            log.warning("llm.gateway_unreachable", extra={"error": type(e).__name__})
            return Outcome(None, [], None, attempts, "模型网关暂不可达", networks)
        reply = res.json()
        attempts = sorted(
            attempts + reply["attempts"], key=lambda a: by_id[a["provider_id"]]["position"]
        )
        if reply["output"] is not None:
            provider = by_id[reply["provider_id"]]
            return Outcome(reply["output"], reply["unverified"], provider, attempts, None, networks)
    failed = "；".join(f"{by_id[a['provider_id']]['name']}（{a['reason']}）" for a in attempts)
    return Outcome(None, [], None, attempts, f"全部模型供应商不可用：{failed}", networks)


async def record_invocation(
    conn: AsyncConnection,
    outcome: Outcome,
    *,
    actor: str,
    target: str,
    details: dict[str, Any],
    request_id: str,
) -> None:
    """审计 llm.invoked（公网调用必记，G-13）并累计当日用量；不含证据、输出与 Key（C-LLM-15）。"""
    if not outcome.attempts:
        return
    today = datetime.now(UTC).date()
    for a in outcome.attempts:
        if a["outcome"] == "skipped":  # 未发出请求
            continue
        same_day = providers.c.usage_day == today
        await conn.execute(
            update(providers)
            .where(providers.c.id == a["provider_id"])
            .values(
                usage_calls=case((same_day, providers.c.usage_calls + 1), else_=1),
                usage_tokens=case(
                    (same_day, providers.c.usage_tokens + a["tokens"]), else_=a["tokens"]
                ),
                usage_day=today,
            )
        )
    await record(
        conn,
        actor=actor,
        action="llm.invoked",
        target=target,
        before=None,
        after=details
        | {
            "attempts": [
                {
                    "provider_id": a["provider_id"],
                    "network": outcome.networks[a["provider_id"]],
                    "redacted": a["redacted"],
                    "outcome": a["outcome"],
                    "reason": a["reason"],
                    "tokens": a["tokens"],
                }
                for a in outcome.attempts
            ]
        },
        request_id=request_id,
    )
