"""每日哈希链封存与校验（HYD-ARCH-001 §10.1、G-13）。每个用例使用独立的新数据库。"""

import asyncio
import os
import subprocess
from collections.abc import Awaitable, Callable
from datetime import UTC, date, datetime, timedelta

import pytest
from alembic import command
from sqlalchemy import insert, select, text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncConnection

from api_server.audit import audit_log
from api_server.config import ApiConfig
from api_server.db import alembic_config, transaction
from audit_service.seal import DAY, GRACE, audit_seal, seal_pending, verify

D1, D2, D3 = date(2026, 10, 1), date(2026, 10, 2), date(2026, 10, 3)


def at(day: date, hour: int = 12) -> datetime:
    return datetime(day.year, day.month, day.day, hour, tzinfo=UTC)


def run[T](config: ApiConfig, fn: Callable[[AsyncConnection], Awaitable[T]]) -> T:
    async def main() -> T:
        async with transaction(config) as conn:
            return await fn(conn)

    return asyncio.run(main())


def add(owner: ApiConfig, ts: datetime) -> None:
    """以属主写入指定时间的记录：应用账号不能写 ts。"""
    values = {"ts": ts, "actor": "a", "action": "x", "target": "t", "request_id": ts.isoformat()}
    run(owner, lambda conn: conn.execute(insert(audit_log).values(values)))


@pytest.fixture
def seeded(scratch_db: tuple[ApiConfig, ApiConfig]) -> tuple[ApiConfig, ApiConfig]:
    """D1 两条、D2 无记录、D3 一条，已封存至 D3。"""
    owner, app = scratch_db
    command.upgrade(alembic_config(owner), "head")
    for ts in (at(D1), at(D1, 13), at(D3)):
        add(owner, ts)
    assert run(app, lambda conn: seal_pending(conn, at(D3 + DAY, 0) + GRACE)) == [D1, D2, D3]
    return owner, app


def test_seals_each_day_including_empty_ones(seeded: tuple[ApiConfig, ApiConfig]) -> None:
    _, app = seeded

    async def counts(conn: AsyncConnection) -> list[int]:
        return list(
            await conn.scalars(select(audit_seal.c.record_count).order_by(audit_seal.c.day))
        )

    assert run(app, counts) == [2, 0, 1]
    assert run(app, verify) == []
    assert run(app, lambda conn: seal_pending(conn, at(D3 + DAY, 0) + GRACE)) == []


def test_waits_for_grace_after_midnight(scratch_db: tuple[ApiConfig, ApiConfig]) -> None:
    owner, app = scratch_db
    command.upgrade(alembic_config(owner), "head")
    add(owner, at(D1))
    midnight = at(D2, 0)

    assert run(app, lambda conn: seal_pending(conn, midnight + GRACE - timedelta(seconds=1))) == []
    assert run(app, lambda conn: seal_pending(conn, midnight + GRACE)) == [D1]


@pytest.mark.parametrize(
    ("tamper", "failed"),
    [
        ("UPDATE audit_log SET actor = 'x' WHERE ts = '2026-10-01T13:00:00Z'", [D1]),
        ("DELETE FROM audit_log WHERE ts = '2026-10-03T12:00:00Z'", [D3]),
        (
            "INSERT INTO audit_log (ts, actor, action, target, request_id)"
            " VALUES ('2026-10-02T08:00:00Z', 'a', 'x', 't', 'r')",
            [D2],
        ),
        (
            "INSERT INTO audit_log (ts, actor, action, target, request_id)"
            " VALUES ('2026-09-30T08:00:00Z', 'a', 'x', 't', 'r')",
            [date(2026, 9, 30)],
        ),
    ],
    ids=["modify", "delete", "insert-into-sealed-day", "insert-before-chain"],
)
def test_verify_locates_tampered_day(
    seeded: tuple[ApiConfig, ApiConfig], tamper: str, failed: list[date]
) -> None:
    owner, app = seeded

    async def bypass_trigger(conn: AsyncConnection) -> None:
        # 只有属主能停用触发器（G-13 迁移 0001）
        await conn.execute(text("ALTER TABLE audit_log DISABLE TRIGGER audit_log_append_only"))
        await conn.execute(text(tamper))
        await conn.execute(text("ALTER TABLE audit_log ENABLE TRIGGER audit_log_append_only"))

    run(owner, bypass_trigger)

    assert run(app, verify) == failed


def test_verify_command_exit_code(seeded: tuple[ApiConfig, ApiConfig]) -> None:
    owner, app = seeded
    env = os.environ | {
        "HYD_DB_HOST": app.db_host,
        "HYD_DB_PORT": str(app.db_port),
        "HYD_DB_NAME": app.db_name,
        "HYD_DB_PASSWORD_FILE": str(app.db_password_file),
    }

    def verify_command() -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["hyd-audit", "verify"], env=env, capture_output=True, text=True, timeout=60
        )

    assert verify_command().returncode == 0
    add(owner, at(D2))
    result = verify_command()
    assert result.returncode == 1
    assert D2.isoformat() in result.stderr


@pytest.mark.parametrize("sql", ["UPDATE audit_seal SET hash = '\\x00'", "DELETE FROM audit_seal"])
@pytest.mark.parametrize("account", [0, 1], ids=["owner", "app"])
def test_seal_records_are_append_only(
    seeded: tuple[ApiConfig, ApiConfig], sql: str, account: int
) -> None:
    with pytest.raises(DBAPIError, match="只允许追加|permission denied"):
        run(seeded[account], lambda conn: conn.execute(text(sql)))
    assert run(seeded[1], verify) == []
