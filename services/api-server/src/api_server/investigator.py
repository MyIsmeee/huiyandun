"""AI 安全值班员（TK-116、US-11、D-087）：high 及以上的关联事件逐个排队调查。

每轮把事件与已执行的工具结果交给 llm-gateway（任务 incident_investigation），模型选择一个只读工具或给出判定；
最多 8 轮、60 s（FR-1101、SC-08）。每一帧写入 ai_investigation 并经 /ws 的 ai 频道推送（FR-1102）；无输出时
推送失败原因，规则结论、关联事件与处置照常（FR-1105、G-01）。判定只用于展示与报告：本模块不 import 处置模块，
不发布任何事件（FR-1106、G-03）。
"""

import asyncio
import logging
import time
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import Column, DateTime, MetaData, Table, Text, select, update
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import SQLAlchemyError

from api_server import llm_chain
from api_server.auth import require
from api_server.investigation_tools import ToolResult
from py_contracts.api import Investigation, WsFrame
from py_contracts.events.hyd_ai_investigation_v1_schema import AiInvestigationV1
from py_contracts.events.hyd_correlator_incident_v1_schema import CorrelatorIncidentV1

TASK = "incident_investigation"
ACTOR = "ai-investigator"
MAX_ROUNDS, DEADLINE_S = 8, 60.0
STALE = timedelta(minutes=10)  # 重启后从 JetStream 重放的旧事件不补调查
SEVERITIES = {"high", "critical"}
ENVELOPE = {"schema_version", "event_id", "ts"}

log = logging.getLogger(__name__)

# 表结构由迁移 0007 定义
investigation_table = Table(
    "ai_investigation",
    MetaData(),
    Column("incident_id", Text, primary_key=True),
    Column("steps", JSONB),
    Column("verdict", JSONB(none_as_null=True)),
    Column("error", Text),
    Column("provider", JSONB(none_as_null=True)),
    Column("started_at", DateTime(timezone=True)),
    Column("finished_at", DateTime(timezone=True)),
)

router = APIRouter(prefix="/api")


class Investigator:
    def __init__(self, state: Any) -> None:
        self._state = state
        self._queue: asyncio.Queue[CorrelatorIncidentV1] = asyncio.Queue()
        self._submitted: set[str] = set()

    def submit(self, incident: CorrelatorIncidentV1) -> None:
        """同一事件的后续状态更新不重复提交；库中已有记录的由 _investigate 跳过。"""
        if incident.severity not in SEVERITIES or incident.id in self._submitted:
            return
        if datetime.now(UTC) - incident.created_at > STALE:
            return
        self._submitted.add(incident.id)
        self._queue.put_nowait(incident)

    async def run(self) -> None:
        try:  # 数据库暂不可达时只记日志：后台任务照常等待调查，未结束的记录留到下次启动再标记
            async with self._state.engine.begin() as conn:
                await conn.execute(
                    update(investigation_table)
                    .where(investigation_table.c.finished_at.is_(None))
                    .values(error="服务重启，调查中断", finished_at=datetime.now(UTC))
                )
        except (SQLAlchemyError, OSError) as e:
            log.warning("ai.interrupt_mark_failed", extra={"error": repr(e)})
        while True:
            incident = await self._queue.get()
            run = _Run(self._state, incident)
            try:
                await run.execute()
            except Exception:  # 单个事件出错（如数据库超时）不中断后续调查
                log.exception("ai.investigation_error", extra={"incident_id": incident.id})
                try:  # 尽量补发失败帧并结束记录，面板不会一直显示进行中（FR-1105）
                    await run.fail("调查出错，详见服务日志")
                except (SQLAlchemyError, OSError) as e:
                    log.warning("ai.fail_mark_failed", extra={"error": repr(e)})


class _Run:
    """一次调查：steps 为交给模型的工具、参数与结果，shown 为展示与落库的步骤。"""

    def __init__(self, state: Any, incident: CorrelatorIncidentV1) -> None:
        self._state, self._id = state, incident.id
        self._incident = incident.model_dump(mode="json", exclude=ENVELOPE)
        self._steps: list[dict[str, Any]] = []
        self._shown: list[dict[str, Any]] = []
        self._seq = self._round = 0
        self._provider: dict[str, str] | None = None

    async def execute(self) -> None:
        async with self._state.engine.begin() as conn:
            created = await conn.execute(
                pg_insert(investigation_table)
                .values(incident_id=self._id, steps=[], started_at=datetime.now(UTC))
                .on_conflict_do_nothing()
            )
        if created.rowcount == 0:
            return
        deadline = time.monotonic() + DEADLINE_S
        for done in range(MAX_ROUNDS):
            self._round = done + 1
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                await self._emit("failed", None, error=f"未能在 {DEADLINE_S:g} 秒内给出判定")
                return
            data = {"incident": self._incident, "steps": self._steps,
                    "rounds_left": MAX_ROUNDS - done}  # fmt: skip
            evidence = {"incident": self._incident, "results": [s["result"] for s in self._steps]}
            outcome = await llm_chain.invoke(
                self._state, TASK, data, deadline_s=remaining, evidence=evidence
            )
            if outcome.provider is not None:
                self._provider = {
                    "name": outcome.provider["name"],
                    "location": outcome.provider["network"],
                }
            if outcome.output is None:
                await self._emit("failed", outcome, error=outcome.reason)
                return
            turn = outcome.output
            if turn["action"] == "verdict":
                verdict = turn["verdict"] | {"unverified": outcome.unverified}
                await self._emit("verdict", outcome, verdict=verdict)
                return
            result = await self._tool(turn["tool"], turn["args"])
            self._steps.append({"tool": turn["tool"], "args": turn["args"], "result": result.data})
            step = {"tool": turn["tool"], "args_summary": result.args_summary,
                    "result_summary": result.summary, "reason": turn["reason"]}  # fmt: skip
            self._shown.append(step)
            await self._emit("step", outcome, step=step)
        await self._emit("failed", None, error=f"{MAX_ROUNDS} 轮内未给出判定")

    async def _tool(self, tool: str, args: dict[str, Any]) -> ToolResult:
        """与此前某步完全相同的调用不重复执行，提示换个查询或给出判定（借鉴 DeepSeek Harness）。"""
        for n, s in enumerate(self._steps):
            if (s["tool"], s["args"]) == (tool, args):
                error = f"与第 {n + 1} 步相同，请换一个查询或给出判定"
                summary = "重复查询，已提示换个查询或给出判定"
                return ToolResult(self._shown[n]["args_summary"], {"error": error}, summary)
        return await self._state.tools.run(tool, args)

    async def fail(self, error: str) -> None:
        await self._emit("failed", None, error=error)

    async def _emit(
        self,
        kind: str,
        outcome: llm_chain.Outcome | None,
        *,
        step: dict[str, Any] | None = None,
        verdict: dict[str, Any] | None = None,
        error: str | None = None,
    ) -> None:
        """落库、写本轮 llm.invoked 与用量（同一事务，G-13），再推送。"""
        frame = AiInvestigationV1.model_validate(
            {
                "schema_version": "1.0.0",
                "event_id": uuid.uuid4(),
                "ts": datetime.now(UTC),
                "incident_id": self._id,
                "seq": self._seq,
                "kind": kind,
                "step": step,
                "verdict": verdict,
                "error": error,
                "provider": self._provider,
            }  # fmt: skip
        )
        self._seq += 1
        finished = kind != "step"
        async with self._state.engine.begin() as conn:
            await conn.execute(
                update(investigation_table)
                .where(investigation_table.c.incident_id == self._id)
                .values(
                    steps=self._shown,
                    verdict=verdict,
                    error=error,
                    provider=self._provider,
                    finished_at=frame.ts if finished else None,
                )
            )
            if outcome is not None:
                await llm_chain.record_invocation(
                    conn,
                    outcome,
                    actor=ACTOR,
                    target=self._id,
                    details={"task": TASK, "round": self._round},
                    request_id=str(frame.event_id),
                )
        self._state.hub.broadcast(WsFrame(channel="ai", data=frame.model_dump(mode="json")))
        if finished:
            log.info("ai.investigation_finished", extra={"incident_id": self._id, "kind": kind})


@router.get("/incidents/{incident_id}/investigation", dependencies=[Depends(require("viewer"))])
async def get_investigation(incident_id: str, request: Request) -> Investigation:
    async with request.app.state.engine.connect() as conn:
        row = (
            (
                await conn.execute(
                    select(investigation_table).where(
                        investigation_table.c.incident_id == incident_id
                    )
                )
            )
            .mappings()
            .first()
        )
    if row is None:
        raise HTTPException(404, "该关联事件尚未开始调查")
    return Investigation.model_validate(dict(row))
