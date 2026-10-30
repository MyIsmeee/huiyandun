"""手动回滚（FR-405、TK-052）：校验执行处于已生效状态后，向 playbook-executor 发布回滚请求并写审计。

回滚由 executor 执行，结果经 WS executions 频道推送；本接口只受理，返回当前执行状态。
"""

import uuid
from datetime import UTC, datetime
from typing import Annotated

import nats
from fastapi import APIRouter, Depends, HTTPException, Request

from api_server.audit import record
from api_server.auth import Principal, require
from py_contracts.events.hyd_playbook_rollback_v1_schema import PlaybookRollbackV1
from py_contracts.events.playbook_execution_schema import PlaybookExecution

ROLLBACK_SUBJECT = "hyd.playbook.rollback.v1"

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
        raise HTTPException(503, "处置执行器暂不可达，请稍后重试") from e
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
    return PlaybookExecution.model_validate(
        execution.model_dump(mode="json", exclude={"schema_version", "event_id", "ts"})
    )
