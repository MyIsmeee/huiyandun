"""审计日志写入与查询（G-13）。"""

from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query, Request
from pydantic import AwareDatetime
from sqlalchemy import BigInteger, Column, DateTime, MetaData, Table, Text, insert, select
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.asyncio import AsyncConnection

from api_server.auth import require
from py_contracts.api import AuditLog, AuditLogList

# 表结构由迁移 0001 定义，此处只声明读写用到的列
audit_log = Table(
    "audit_log",
    MetaData(),
    Column("id", BigInteger, primary_key=True),
    Column("ts", DateTime(timezone=True)),
    Column("actor", Text),
    Column("action", Text),
    Column("target", Text),
    Column("before", JSONB(none_as_null=True)),
    Column("after", JSONB(none_as_null=True)),
    Column("request_id", Text),
)


async def record(
    conn: AsyncConnection,
    *,
    actor: str,
    action: str,
    target: str,
    before: dict[str, Any] | None,
    after: dict[str, Any] | None,
    request_id: str,
) -> None:
    """与业务变更在同一事务内写入：由调用方提交，业务回滚时审计记录一并回滚。"""
    await conn.execute(
        insert(audit_log).values(
            actor=actor,
            action=action,
            target=target,
            before=before,
            after=after,
            request_id=request_id,
        )
    )


router = APIRouter(prefix="/api")


@router.get("/audit-logs", dependencies=[Depends(require("auditor"))])
async def list_audit_logs(
    request: Request,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    before: AwareDatetime | None = None,
) -> AuditLogList:
    query = select(audit_log).order_by(audit_log.c.ts.desc(), audit_log.c.id.desc()).limit(limit)
    if before is not None:
        query = query.where(audit_log.c.ts < before)
    async with request.app.state.engine.connect() as conn:
        rows = (await conn.execute(query)).mappings().all()
    return AuditLogList(
        items=[AuditLog.model_validate(dict(r) | {"id": str(r["id"])}) for r in rows]
    )
