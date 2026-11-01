"""手动回滚（FR-405、TK-052）与确认处置（FR-407、TK-117）：校验前置状态后向 playbook-executor 发布请求并写审计。

处置与回滚由 executor 执行，结果经 WS executions 频道推送；本模块只受理。确认只提交关联事件 ID，
目标与 Playbook 由 executor 取自关联事件的结构化字段（G-03）。
审计与发布在同一事务内：先写审计再发布，发布失败时审计随事务回滚，写审计失败时不发布（G-13）。
"""

import uuid
from datetime import UTC, datetime
from typing import Annotated

import nats
from fastapi import APIRouter, Depends, HTTPException, Request, Response

from api_server.audit import record
from api_server.auth import Principal, require
from py_contracts.events.hyd_correlator_confirmation_v1_schema import CorrelatorConfirmationV1
from py_contracts.events.hyd_playbook_rollback_v1_schema import PlaybookRollbackV1
from py_contracts.events.playbook_execution_schema import PlaybookExecution

ROLLBACK_SUBJECT = "hyd.playbook.rollback.v1"
CONFIRMATION_SUBJECT = "hyd.correlator.confirmation.v1"
UNREACHABLE = "处置执行器暂不可达，请稍后重试"

router = APIRouter(prefix="/api")


@router.post("/executions/{execution_id}/rollback")
async def rollback_execution(
    execution_id: str,
    request: Request,
    principal: Annotated[Principal, Depends(require("operator"))],
) -> PlaybookExecution:
    execution = request.app.state.history.execution(execution_id)
    if execution is None:
        raise HTTPException(404, "处置执行不存在或已超过 24 小时")
    if execution.state != "contained":
        raise HTTPException(409, f"处置执行处于 {execution.state}，无需回滚")
    request_id = request.state.request_id
    async with request.app.state.engine.begin() as conn:
        await record(
            conn,
            actor=principal.username,
            action="playbook.rollback_requested",
            target=execution.target,
            before={"execution_id": execution_id, "state": execution.state},
            after=None,
            request_id=request_id,
        )
        try:
            await request.app.state.bus.js_publish(
                ROLLBACK_SUBJECT,
                PlaybookRollbackV1(
                    schema_version="1.0.0",
                    event_id=uuid.uuid4(),
                    ts=datetime.now(UTC),
                    execution_id=execution_id,
                    actor=principal.username,
                    request_id=request_id,
                ),
            )
        except (nats.errors.Error, TimeoutError) as e:
            raise HTTPException(503, UNREACHABLE) from e
    return PlaybookExecution.model_validate(
        execution.model_dump(mode="json", exclude={"schema_version", "event_id", "ts"})
    )


@router.post("/incidents/{incident_id}/confirm-containment", status_code=202)
async def confirm_containment(
    incident_id: str,
    request: Request,
    principal: Annotated[Principal, Depends(require("operator"))],
) -> Response:
    incident = request.app.state.history.incident(incident_id)
    if incident is None:
        raise HTTPException(404, "关联事件不存在或已超过 24 小时")
    if not incident.requires_confirmation:
        raise HTTPException(400, "该关联事件无需人工确认")
    request_id = request.state.request_id
    async with request.app.state.engine.begin() as conn:
        await record(
            conn,
            actor=principal.username,
            action="incident.containment_confirmed",
            target=incident_id,
            before={"status": incident.status},
            after=None,
            request_id=request_id,
        )
        try:
            await request.app.state.bus.js_publish(
                CONFIRMATION_SUBJECT,
                CorrelatorConfirmationV1(
                    schema_version="1.0.0",
                    event_id=uuid.uuid4(),
                    ts=datetime.now(UTC),
                    incident_id=incident_id,
                    actor=principal.username,
                    request_id=request_id,
                ),
            )
        except (nats.errors.Error, TimeoutError) as e:
            raise HTTPException(503, UNREACHABLE) from e
    return Response(status_code=202)
