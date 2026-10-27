"""审计日志写入（G-13）。"""

from typing import Any

from sqlalchemy import BigInteger, Column, DateTime, MetaData, Table, Text, insert
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.asyncio import AsyncConnection

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
