"""审计表只追加（G-13）：UPDATE / DELETE / TRUNCATE 对应用账号与属主均被拒绝。"""

import asyncio
import uuid
from collections.abc import Awaitable, Callable

import pytest
from sqlalchemy import func, select, text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncConnection

from api_server.audit import audit_log, record
from api_server.config import ApiConfig
from api_server.db import transaction

MODIFICATIONS = ["UPDATE audit_log SET actor = 'x'", "DELETE FROM audit_log", "TRUNCATE audit_log"]


def in_transaction[T](config: ApiConfig, fn: Callable[[AsyncConnection], Awaitable[T]]) -> T:
    async def main() -> T:
        async with transaction(config) as conn:
            return await fn(conn)

    return asyncio.run(main())


def append(config: ApiConfig, request_id: str) -> None:
    in_transaction(
        config,
        lambda conn: record(
            conn, actor="alice", action="a", target="t", before=None, after={"enabled": True},
            request_id=request_id,
        ),
    )  # fmt: skip


def count(config: ApiConfig, request_id: str) -> int:
    query = select(func.count()).where(audit_log.c.request_id == request_id)
    return in_transaction(config, lambda conn: conn.scalar(query))


@pytest.fixture
def request_id(db: tuple[ApiConfig, ApiConfig]) -> str:
    """每个用例先以应用账号追加一条记录。"""
    request_id = str(uuid.uuid4())
    append(db[1], request_id)
    return request_id


def test_app_role_appends_and_reads(db: tuple[ApiConfig, ApiConfig], request_id: str) -> None:
    query = select(audit_log.c.ts, audit_log.c.before.is_(None)).where(
        audit_log.c.request_id == request_id
    )
    rows = in_transaction(db[1], lambda conn: conn.execute(query)).all()

    assert len(rows) == 1
    ts, before_is_sql_null = rows[0]
    assert ts.utcoffset() is not None
    assert before_is_sql_null


@pytest.mark.parametrize("sql", MODIFICATIONS)
def test_app_role_cannot_modify(db: tuple[ApiConfig, ApiConfig], request_id: str, sql: str) -> None:
    with pytest.raises(DBAPIError, match="permission denied"):
        in_transaction(db[1], lambda conn: conn.execute(text(sql)))
    assert count(db[1], request_id) == 1


@pytest.mark.parametrize("sql", MODIFICATIONS)
def test_owner_is_rejected_by_trigger(
    db: tuple[ApiConfig, ApiConfig], request_id: str, sql: str
) -> None:
    with pytest.raises(DBAPIError, match="audit_log 只允许追加"):
        in_transaction(db[0], lambda conn: conn.execute(text(sql)))
    assert count(db[1], request_id) == 1


@pytest.mark.parametrize(
    "sql",
    [
        "ALTER TABLE audit_log DISABLE TRIGGER audit_log_append_only",
        "DROP TRIGGER audit_log_append_only ON audit_log",
        "INSERT INTO audit_log (ts, actor, action, target, request_id)"
        " VALUES ('2020-01-01T00:00:00Z', 'a', 'b', 'c', 'd')",
    ],
    ids=["disable-trigger", "drop-trigger", "forge-ts"],
)
def test_app_role_cannot_bypass(db: tuple[ApiConfig, ApiConfig], sql: str) -> None:
    with pytest.raises(DBAPIError, match="must be owner|permission denied"):
        in_transaction(db[1], lambda conn: conn.execute(text(sql)))


def test_record_rolls_back_with_business_transaction(db: tuple[ApiConfig, ApiConfig]) -> None:
    request_id = str(uuid.uuid4())

    async def fail_after_record(conn: AsyncConnection) -> None:
        await record(
            conn, actor="a", action="a", target="t", before=None, after=None, request_id=request_id
        )
        raise RuntimeError("业务失败")

    with pytest.raises(RuntimeError):
        in_transaction(db[1], fail_after_record)
    assert count(db[1], request_id) == 0
