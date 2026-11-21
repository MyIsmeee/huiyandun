"""调用链接入（TK-062）：把已启用供应商（按故障转移顺序、Key 已解密）连同证据转交 llm-gateway，
api-server 自身不访问供应商（C-LLM-01）。

无输出时给出模板原因（FR-502）；审计与当日用量由调用方在业务事务中写入（G-13、D-084）。
报告与值班员都经 invoke 调用，最近一次的结果记在内存中，供顶栏模型状态使用（V-M8，重启即清空）。
调用方给出事件等级时，网关按任务的路由策略调整顺序（deploy/configs/llm-tasks.yaml 的 routing）：critical 升阶到
公网（云端）优先，其余内网（本地）优先；本次的路由与首选供应商记入 Outcome 与审计。
"""

import logging
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

import httpx2
from cryptography.exceptions import InvalidTag
from fastapi import APIRouter, Depends, Request
from sqlalchemy import case, select, update
from sqlalchemy.ext.asyncio import AsyncConnection

from api_server.audit import record
from api_server.auth import require
from api_server.llm import block_public, providers, unseal
from py_contracts.api import LlmStatus

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
    networks: dict[str, str]  # 供应商 ID → 网络位置，供审计；键序即调用时已启用供应商的顺序
    route: str = "manual"  # manual 管理员排定的顺序；local_first 本地优先；escalated 升阶到云端优先
    first: str | None = None  # 路由后首选的供应商 ID；未经网关路由时为 None，即顺序中的第一家


router = APIRouter(prefix="/api/llm")


def _skipped(provider_id: str, reason: str) -> dict[str, Any]:
    return {
        "provider_id": provider_id,
        "outcome": "skipped",
        "reason": reason,
        "latency_ms": None,
        "tokens": 0,
        "redacted": False,
    }


async def invoke(
    state: Any,
    task: str,
    data: dict[str, Any],
    *,
    deadline_s: float | None = None,
    evidence: dict[str, Any] | None = None,
    severity: str | None = None,
) -> Outcome:
    outcome = await _invoke(
        state, task, data, deadline_s=deadline_s, evidence=evidence, severity=severity
    )
    state.llm_last = outcome
    return outcome


async def _invoke(
    state: Any,
    task: str,
    data: dict[str, Any],
    *,
    deadline_s: float | None = None,
    evidence: dict[str, Any] | None = None,
    severity: str | None = None,
) -> Outcome:
    """state 为 app.state；deadline_s 为调用方剩余时间，evidence 为事实回溯依据（缺省为 data）；
    severity 为所研判事件的等级，供网关按等级路由。"""
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
        # 开启时公网供应商已全部停用；仍随请求交给网关，由它按地址实际指向再复核一次（G-02）
        blocked = await block_public(conn)
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
        body = {"task": task, "data": data, "providers": targets, "deadline_s": deadline_s,
                "evidence": evidence, "severity": severity, "block_public": blocked}  # fmt: skip
        try:
            res = await state.llm_gateway.post(
                "/internal/invoke", json=body, timeout=(deadline_s or DEADLINE_S) + MARGIN_S
            )
            res.raise_for_status()
        except httpx2.HTTPError as e:
            log.warning("llm.gateway_unreachable", extra={"error": type(e).__name__})
            return Outcome(None, [], None, attempts, "模型网关暂不可达", networks)
        reply = res.json()
        route, order = reply.get("route", "manual"), reply.get("order") or []
        first = order[0] if order else None
        if route == "manual":
            attempts = sorted(
                attempts + reply["attempts"], key=lambda a: by_id[a["provider_id"]]["position"]
            )
        else:
            # 经路由：按实际尝试的先后；未发给网关的（Key 无法解密）排在最后
            attempts = reply["attempts"] + attempts
        if reply["output"] is not None:
            provider = by_id[reply["provider_id"]]
            return Outcome(
                reply["output"], reply["unverified"], provider, attempts, None, networks,
                route, first,
            )  # fmt: skip
        failed = "；".join(f"{by_id[a['provider_id']]['name']}（{a['reason']}）" for a in attempts)
        reason = f"全部模型供应商不可用：{failed}"
        return Outcome(None, [], None, attempts, reason, networks, route, first)
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
        | ({} if outcome.route == "manual" else {"route": outcome.route})
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


@router.get("/status", dependencies=[Depends(require("viewer"))])
async def llm_status(request: Request) -> LlmStatus:
    """以最近一次调用为准；之后管理员改了启用或顺序，则不再沿用那次的结果（设计 071 §3）。"""
    async with request.app.state.engine.connect() as conn:
        rows = (
            await conn.execute(
                select(providers.c.id, providers.c.name)
                .where(providers.c.enabled)
                .order_by(providers.c.position)
            )
        ).all()
    if not rows:
        return LlmStatus(state="template", provider_name=None, reason="未启用任何模型供应商")
    last: Outcome | None = request.app.state.llm_last
    if last is None or list(last.networks) != [r.id for r in rows]:
        return LlmStatus(state="normal", provider_name=rows[0].name, reason=None)
    if last.provider is None:
        return LlmStatus(state="template", provider_name=None, reason=last.reason)
    # 经路由时以路由后的首选为准：升阶到云端并成功不算故障转移
    state = "normal" if last.provider["id"] == (last.first or rows[0].id) else "failover"
    return LlmStatus(state=state, provider_name=last.provider["name"], reason=None)
