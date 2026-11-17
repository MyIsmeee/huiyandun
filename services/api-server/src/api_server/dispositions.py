"""告警处置：值班员对单条告警标记已确认、误报或已处理（告警闭环）。

处置记录即审计日志中 action 为 alert.disposed 的条目（G-13），不另建表：启动时从审计日志读回近 24 小时的记录，
之后随写入在内存中更新，连接建立时补推。误报与已处理解除该摄像头的物理告警态；已确认只让控制台停止响铃与弹窗。
"""

import asyncio
import logging
import time
from datetime import UTC, datetime, timedelta
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncEngine

from api_server.audit import audit_log, record
from api_server.auth import Principal, require
from py_contracts.api import AlertDisposition, AlertDispositionRequest, WsFrame
from py_contracts.events.hyd_vision_behavior_v1_schema import VisionBehaviorV1
from py_contracts.events.hyd_vision_rule_v1_schema import VisionRuleV1

ACTION = "alert.disposed"
WINDOW = timedelta(hours=24)  # 与告警记录的补推窗口一致（D-077）
RELEASING = ("false_positive", "resolved")  # 解除物理告警态的处置
RETRY_S = 5.0

log = logging.getLogger(__name__)


class Dispositions:
    """各告警最近一次处置，键为 event_id。"""

    def __init__(self) -> None:
        self._latest: dict[str, AlertDisposition] = {}

    async def restore(self, engine: AsyncEngine) -> None:
        """读回近 24 小时的处置记录；数据库暂不可达时每 RETRY_S 秒重试，直到成功。"""
        while True:
            try:
                await self.load(engine)
                return
            except (OSError, SQLAlchemyError) as e:
                log.warning("api.dispositions_restore_failed", extra={"error": repr(e)})
                await asyncio.sleep(RETRY_S)

    async def load(self, engine: AsyncEngine) -> None:
        since = datetime.now(UTC) - WINDOW
        async with engine.connect() as conn:
            rows = await conn.execute(
                select(audit_log.c.ts, audit_log.c.actor, audit_log.c.target, audit_log.c.after)
                .where(audit_log.c.action == ACTION, audit_log.c.ts >= since)
                .order_by(audit_log.c.id)
            )
            for row in rows:
                after = row.after or {}
                # 读回期间已有新的处置时以新的为准
                if (latest := self._latest.get(row.target)) is not None and latest.ts >= row.ts:
                    continue
                self.add(
                    AlertDisposition.model_validate(
                        {
                            "event_id": row.target,
                            "action": after.get("action"),
                            "note": after.get("note"),
                            "actor": row.actor,
                            "ts": row.ts,
                        }
                    )
                )

    def add(self, disposition: AlertDisposition) -> None:
        self._latest[str(disposition.event_id)] = disposition

    def get(self, event_id: str) -> AlertDisposition | None:
        return self._latest.get(event_id)

    def snapshot(self) -> list[WsFrame]:
        since = datetime.now(UTC) - WINDOW
        return [
            WsFrame(channel="dispositions", data=d.model_dump(mode="json"))
            for d in sorted(self._latest.values(), key=lambda d: d.ts)
            if d.ts >= since
        ]


router = APIRouter(prefix="/api")


@router.post("/alerts/{event_id}/disposition")
async def dispose_alert(
    event_id: UUID,
    body: AlertDispositionRequest,
    request: Request,
    principal: Annotated[Principal, Depends(require("operator"))],
) -> AlertDisposition:
    state = request.app.state
    alert = state.history.event(event_id)
    if alert is None:
        raise HTTPException(404, "告警不存在或已超过 24 小时")
    action = body.action.root
    previous = state.dispositions.get(str(event_id))
    disposition = AlertDisposition.model_validate(
        {
            "event_id": event_id,
            "action": action,
            "note": body.note,
            "actor": principal.username,
            "ts": datetime.now(UTC),
        }
    )
    async with state.engine.begin() as conn:
        await record(
            conn,
            actor=principal.username,
            action=ACTION,
            target=str(event_id),
            before=previous.model_dump(mode="json", include={"action", "note"})
            if previous
            else None,
            after={"action": action, "note": body.note},
            request_id=request.state.request_id,
        )
    state.dispositions.add(disposition)
    state.hub.broadcast(WsFrame(channel="dispositions", data=disposition.model_dump(mode="json")))
    if action in RELEASING and isinstance(alert, VisionBehaviorV1 | VisionRuleV1):
        device = state.devices.release_physical(alert.camera_id, time.monotonic())
        if device is not None:
            state.hub.broadcast(WsFrame(channel="devices", data=device.model_dump(mode="json")))
    return disposition
