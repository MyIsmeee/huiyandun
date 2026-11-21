"""删除告警：值班员把告警与关联事件从告警栏移除。

只是不再列出：原始事件留在 JetStream、存证与处置执行照常，删除本身记入审计日志（action 为 alerts.cleared，
G-13），不另建表。启动时从审计日志读回近 24 小时的删除记录，之后随写入在内存中更新；连接建立时先于告警补推，
控制台据此过滤补推的告警与关联事件。
"""

import asyncio
import logging
from datetime import UTC, datetime, timedelta
from typing import Annotated

from fastapi import APIRouter, Depends, Request
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncEngine

from api_server.audit import audit_log, record
from api_server.auth import Principal, require
from py_contracts.api import AlertClearRequest, AlertsCleared, WsFrame

ACTION = "alerts.cleared"
TARGET = "alerts"
WINDOW = timedelta(hours=24)  # 与告警记录的补推窗口一致（D-077）
RETRY_S = 5.0

log = logging.getLogger(__name__)


class Cleared:
    """近 24 小时的删除记录，按发生先后。"""

    def __init__(self) -> None:
        self._records: list[AlertsCleared] = []

    async def restore(self, engine: AsyncEngine) -> None:
        """读回近 24 小时的删除记录；数据库暂不可达时每 RETRY_S 秒重试，直到成功。"""
        while True:
            try:
                await self.load(engine)
                return
            except (OSError, SQLAlchemyError) as e:
                log.warning("api.cleared_restore_failed", extra={"error": repr(e)})
                await asyncio.sleep(RETRY_S)

    async def load(self, engine: AsyncEngine) -> None:
        since = datetime.now(UTC) - WINDOW
        async with engine.connect() as conn:
            rows = await conn.execute(
                select(audit_log.c.ts, audit_log.c.actor, audit_log.c.after)
                .where(audit_log.c.action == ACTION, audit_log.c.ts >= since)
                .order_by(audit_log.c.id)
            )
            restored = [
                AlertsCleared.model_validate(
                    {
                        "event_ids": (row.after or {}).get("event_ids", []),
                        "incident_ids": (row.after or {}).get("incident_ids", []),
                        "actor": row.actor,
                        "ts": row.ts,
                    }
                )
                for row in rows
            ]
        # 读回期间已有新的删除时，读回的排在前面
        self._records = restored + self._records

    def add(self, cleared: AlertsCleared) -> None:
        self._records.append(cleared)

    def snapshot(self) -> list[WsFrame]:
        since = datetime.now(UTC) - WINDOW
        return [
            WsFrame(channel="cleared", data=c.model_dump(mode="json"))
            for c in self._records
            if c.ts >= since
        ]


router = APIRouter(prefix="/api")


@router.post("/alerts/clear")
async def clear_alerts(
    body: AlertClearRequest,
    request: Request,
    principal: Annotated[Principal, Depends(require("operator"))],
) -> AlertsCleared:
    state = request.app.state
    cleared = AlertsCleared.model_validate(
        {
            "event_ids": body.event_ids,
            "incident_ids": [i.root for i in body.incident_ids],
            "actor": principal.username,
            "ts": datetime.now(UTC),
        }
    )
    data = cleared.model_dump(mode="json")
    async with state.engine.begin() as conn:
        await record(
            conn,
            actor=principal.username,
            action=ACTION,
            target=TARGET,
            before=None,
            after={"event_ids": data["event_ids"], "incident_ids": data["incident_ids"]},
            request_id=request.state.request_id,
        )
    state.cleared.add(cleared)
    state.hub.broadcast(WsFrame(channel="cleared", data=data))
    return cleared
