"""处置执行写审计（G-13、TK-050）：对真实 PostgreSQL 与 nats-server 运行。"""

import asyncio
import logging
import uuid
from datetime import UTC, datetime
from typing import Any

import nats
import nats.js.errors
import pytest
from sqlalchemy import func, select, text
from sqlalchemy.exc import DBAPIError, IntegrityError, OperationalError, SQLAlchemyError
from sqlalchemy.exc import TimeoutError as PoolTimeout

from api_server import executions
from api_server.audit import audit_log
from api_server.config import ApiConfig
from api_server.db import create_engine
from py_common.bus import Bus
from py_contracts.events.hyd_playbook_execution_v1_schema import PlaybookExecutionV1

STREAM = "HYD_PLAYBOOK"


def execution(state: str, reason: str | None = None) -> PlaybookExecutionV1:
    return PlaybookExecutionV1.model_validate(
        {
            "schema_version": "1.1.0",
            "event_id": str(uuid.uuid4()),
            "ts": datetime.now(UTC).isoformat(),
            "id": "exe-audit",
            "playbook_id": "isolate-attacker",
            "playbook_version": "1.0.0",
            "incident_id": "inc-1",
            "device_ids": ["cam-02"],
            "target": "172.30.0.100",
            "state": state,
            "reason": reason,
            "ttl_s": 150,
            "expires_at": None,
            "verify_result": None,
        }
    )


async def audited(config: ApiConfig) -> list[tuple[str, str, str]]:
    engine = create_engine(config)
    try:
        async with engine.connect() as conn:
            rows = await conn.execute(
                select(audit_log.c.actor, audit_log.c.action, audit_log.c.target)
                .where(audit_log.c.actor == executions.ACTOR)
                .order_by(audit_log.c.id)
            )
            return [tuple(r) for r in rows]
    finally:
        await engine.dispose()


def test_each_state_change_audited_once_across_restart(
    db: tuple[ApiConfig, ApiConfig], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(executions, "RETRY_S", 0.1)
    config = db[1]
    states = [
        execution("executing"),
        execution("contained"),
        execution("rolled_back", "TTL 到期自动解除"),
    ]

    async def scenario() -> list[tuple[str, str, str]]:
        raw = await nats.connect(config.nats_url)
        try:
            await raw.jetstream().delete_stream(STREAM)
        except nats.js.errors.NotFoundError:
            pass
        await raw.close()
        bus = await Bus.connect(config.nats_url, name="test", timeout_s=2)
        engine = create_engine(config)
        # 流尚未创建（executor 未启动）：记录后重试
        task = asyncio.create_task(executions.follow(bus, engine))
        await asyncio.sleep(0.3)
        await bus.ensure_stream(STREAM, [executions.SUBJECT], 3600)
        await asyncio.wait_for(task, 5)
        for e in states:
            await bus.js_publish(executions.SUBJECT, e)
        await asyncio.sleep(0.5)

        # 重启：从最近审计时刻前一分钟起重放，已写过的跳过
        restarted = await Bus.connect(config.nats_url, name="restarted", timeout_s=2)
        await executions.follow(restarted, engine)
        await asyncio.sleep(0.5)
        await restarted.close()
        await bus.close()
        await engine.dispose()
        return await audited(config)

    assert asyncio.run(scenario()) == [
        ("playbook-executor", "playbook.executing", "172.30.0.100"),
        ("playbook-executor", "playbook.contained", "172.30.0.100"),
        ("playbook-executor", "playbook.rolled_back", "172.30.0.100"),
    ]


def test_database_unreachable_at_start_retried_not_raised(
    db: tuple[ApiConfig, ApiConfig], monkeypatch: pytest.MonkeyPatch
) -> None:
    """启动时数据库尚未就绪：一直重试、不抛错（否则后台任务结束，整个进程生命周期都不写处置审计）。"""
    monkeypatch.setattr(executions, "RETRY_S", 0.05)
    config = db[1].model_copy(update={"db_host": "db.invalid", "db_timeout_s": 0.5})

    async def scenario() -> bool:
        bus = await Bus.connect(config.nats_url, name="test", timeout_s=2)
        engine = create_engine(config)
        task = asyncio.create_task(executions.follow(bus, engine))
        await asyncio.sleep(1.5)
        alive = not task.done()
        task.cancel()
        await bus.close()
        await engine.dispose()
        return alive

    assert asyncio.run(scenario())


def server_error(sqlstate: str, message: str) -> Exception:
    """asyncpg 方言转换出的服务端错误：SQLSTATE 记在 sqlstate 上。"""
    error = Exception(message)
    error.sqlstate = sqlstate  # type: ignore[attr-defined]
    return error


@pytest.mark.parametrize(
    "transient",
    [
        DBAPIError("insert", {}, server_error("57P03", "the database system is starting up")),
        DBAPIError("insert", {}, server_error("57P01", "terminating connection")),
        DBAPIError("insert", {}, server_error("53300", "too many connections")),
        DBAPIError("insert", {}, server_error("57014", "canceling statement due to timeout")),
        DBAPIError("insert", {}, Exception("connection was closed in the middle of operation")),
        PoolTimeout("QueuePool limit reached"),
    ],
    ids=["starting", "shutdown", "connections", "canceled", "closed", "pool"],
)
def test_transient_database_errors_retried_without_gap(
    db: tuple[ApiConfig, ApiConfig], monkeypatch: pytest.MonkeyPatch, transient: Exception
) -> None:
    """数据库启动或关闭中、连接数已满、语句被取消、取连接超时：asyncpg 方言一律给出 DBAPIError（不是
    OperationalError），同样要重试到成功，不能当成永久错误跳过。"""
    monkeypatch.setattr(executions, "RETRY_S", 0.05)
    real = executions.record
    calls = {"n": 0}

    async def flaky(*args: Any, **kwargs: Any) -> None:
        calls["n"] += 1
        if calls["n"] == 1:
            raise transient
        await real(*args, **kwargs)

    monkeypatch.setattr(executions, "record", flaky)
    event = execution("contained")

    async def scenario() -> int:
        engine = create_engine(db[1])
        await asyncio.wait_for(executions.audit_execution(engine, event), 5)
        async with engine.connect() as conn:
            count = await conn.scalar(
                select(func.count()).where(audit_log.c.request_id == str(event.event_id))
            )
        await engine.dispose()
        return count or 0

    assert asyncio.run(scenario()) == 1


def test_failed_write_retried_without_gap(
    db: tuple[ApiConfig, ApiConfig], monkeypatch: pytest.MonkeyPatch
) -> None:
    """写审计失败时重试到成功：不能跳过这条，否则审计出现缺口。"""
    monkeypatch.setattr(executions, "RETRY_S", 0.05)
    real = executions.record
    calls = {"n": 0}

    async def flaky(*args: Any, **kwargs: Any) -> None:
        calls["n"] += 1
        if calls["n"] == 1:
            raise OperationalError("insert", {}, Exception("connection lost"))
        await real(*args, **kwargs)

    monkeypatch.setattr(executions, "record", flaky)
    config = db[1]
    event = execution("failed", "privileged-helper 不可达")

    async def scenario() -> int:
        engine = create_engine(config)
        await executions.audit_execution(engine, event)
        async with engine.connect() as conn:
            count = await conn.scalar(
                select(func.count()).where(audit_log.c.request_id == str(event.event_id))
            )
        await engine.dispose()
        return count or 0

    assert asyncio.run(scenario()) == 1


def test_permanent_write_error_logged_and_skipped(
    db: tuple[ApiConfig, ApiConfig],
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """权限不足、数据不合约束等重试也不会好的错误：记为错误后跳过，不卡住后续的处置审计。"""
    monkeypatch.setattr(executions, "RETRY_S", 0.05)

    async def rejected(*args: Any, **kwargs: Any) -> None:
        raise IntegrityError("insert", {}, server_error("23514", "violates check constraint"))

    monkeypatch.setattr(executions, "record", rejected)

    async def scenario() -> None:
        engine = create_engine(db[1])
        await asyncio.wait_for(executions.audit_execution(engine, execution("contained")), 2)
        await engine.dispose()

    with caplog.at_level(logging.ERROR):
        asyncio.run(scenario())
    assert any(r.getMessage() == "api.execution_audit_rejected" for r in caplog.records)


def test_real_constraint_violation_is_permanent(db: tuple[ApiConfig, ApiConfig]) -> None:
    """真实数据库给出的约束错误带 SQLSTATE 23 类，判为永久错误；连接被拒则不是。"""

    async def violation() -> SQLAlchemyError:
        engine = create_engine(db[1])
        try:
            async with engine.begin() as conn:
                await conn.execute(text("INSERT INTO audit_log (actor) VALUES (NULL)"))
        except SQLAlchemyError as e:
            return e
        finally:
            await engine.dispose()
        raise AssertionError("应当违反非空约束")

    error = asyncio.run(violation())
    assert executions._permanent(error)
    assert not executions._permanent(
        DBAPIError("x", {}, server_error("08006", "connection failure"))
    )
