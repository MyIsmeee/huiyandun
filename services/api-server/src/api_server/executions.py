"""处置执行写审计（G-13、TK-050）：playbook-executor 每次状态变化写一条审计记录（执行、生效、回滚、失败等）。

从流中读执行记录，以事件 ID 作 request_id：重启后从最近一条已审计的记录起重放，已写过的跳过，不丢不重。
"""

import asyncio
import logging
from datetime import UTC, datetime, timedelta
from functools import partial

import nats
from sqlalchemy import func, select
from sqlalchemy.exc import DBAPIError, SQLAlchemyError, StatementError
from sqlalchemy.ext.asyncio import AsyncEngine

from api_server.audit import audit_log, record
from py_common.bus import Bus
from py_contracts.events.hyd_playbook_execution_v1_schema import PlaybookExecutionV1

SUBJECT = "hyd.playbook.execution.v1"
ACTOR = "playbook-executor"
FIRST_REPLAY = timedelta(hours=24)  # 尚无审计记录时补近 24 小时（TTL 上限，C-BE-05）
OVERLAP = timedelta(minutes=1)  # 从最近审计时刻前一分钟起重放，重叠部分按事件 ID 跳过
# 数据库未就绪、写入失败、执行记录的流尚未创建（由 playbook-executor 创建）时按此间隔重试
RETRY_S = 5.0
# 重试也不会好的数据库错误的 SQLSTATE 类：22 数据不合类型或长度、23 违反约束、42 语句有误或权限不足。
# 其余（08 连接异常、53 资源不足、57 数据库启动或关闭中与语句被取消、40 死锁等）等一会儿可恢复
PERMANENT_SQLSTATE = ("22", "23", "42")

log = logging.getLogger(__name__)


def _permanent(error: SQLAlchemyError) -> bool:
    """重试也不会好的错误。只认明确属于这一类的：asyncpg 方言不把服务端错误细分（数据库启动中、连接数已满、
    语句被取消都只是 DBAPIError），按异常类型认"连接类"会把它们漏成永久错误，这条审计就此缺失。"""
    if isinstance(error, DBAPIError):
        return str(getattr(error.orig, "sqlstate", None) or "").startswith(PERMANENT_SQLSTATE)
    return isinstance(error, StatementError)  # 语句在发往数据库之前就构造失败


async def audit_execution(engine: AsyncEngine, execution: PlaybookExecutionV1) -> None:
    """权限不足、数据不合约束等重试也不会好的错误记为错误后跳过，不让后续的处置审计全部卡住；其余失败
    （数据库暂不可达、启动或关闭中、连接中断、取连接超时）重试到成功，跳过会让审计出现缺口。"""
    while True:
        try:
            await _write(engine, execution)
            return
        except (SQLAlchemyError, OSError) as e:
            if isinstance(e, SQLAlchemyError) and _permanent(e):
                log.exception("api.execution_audit_rejected", extra={"execution_id": execution.id})
                return
            log.warning(
                "api.execution_audit_failed",
                extra={"execution_id": execution.id, "error": repr(e)},
            )
            await asyncio.sleep(RETRY_S)


async def _write(engine: AsyncEngine, execution: PlaybookExecutionV1) -> None:
    async with engine.begin() as conn:
        written = await conn.scalar(
            select(audit_log.c.id).where(audit_log.c.request_id == str(execution.event_id)).limit(1)
        )
        if written is not None:
            return
        await record(
            conn,
            actor=ACTOR,
            action=f"playbook.{execution.state}",
            target=execution.target,
            before=None,
            after=execution.model_dump(mode="json", exclude={"schema_version", "event_id"}),
            request_id=str(execution.event_id),
        )


async def follow(bus: Bus, engine: AsyncEngine) -> None:
    """数据库或流尚未就绪时一直重试，不让后台任务结束：否则整个进程生命周期都不再写处置审计。"""
    while True:
        try:
            async with engine.connect() as conn:
                last = await conn.scalar(
                    select(func.max(audit_log.c.ts)).where(audit_log.c.actor == ACTOR)
                )
            since = last - OVERLAP if last else datetime.now(UTC) - FIRST_REPLAY
            await bus.js_subscribe(
                SUBJECT, PlaybookExecutionV1, partial(audit_execution, engine), since
            )
            return
        except (SQLAlchemyError, OSError, nats.errors.Error, TimeoutError) as e:
            log.warning("api.execution_follow_failed", extra={"error": repr(e)})
            await asyncio.sleep(RETRY_S)
