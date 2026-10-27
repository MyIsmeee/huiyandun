"""每日哈希链封存与校验（HYD-ARCH-001 §10.1、G-13）。每个用例使用独立的新数据库。"""

import asyncio
import logging
import os
import subprocess
from collections.abc import Awaitable, Callable
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import NamedTuple

import pytest
from alembic import command
from sqlalchemy import insert, select, text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncConnection

from api_server.audit import audit_log
from api_server.config import ApiConfig, DbConfig
from api_server.db import alembic_config, transaction
from audit_service.cli import AuditConfig, seal_once
from audit_service.seal import DAY, GRACE, audit_seal, seal_pending, verify

D1, D2, D3 = date(2026, 10, 1), date(2026, 10, 2), date(2026, 10, 3)


class Accounts(NamedTuple):
    owner: ApiConfig  # 属主：用于写入指定时间的记录与绕过触发器
    audit: AuditConfig  # hyd_audit：audit-service 的账号
    app: ApiConfig  # hyd_app：api-server 的账号


@pytest.fixture
def accounts(scratch_db: tuple[ApiConfig, ApiConfig], db_secrets: dict[str, Path]) -> Accounts:
    owner, app = scratch_db
    command.upgrade(alembic_config(owner), "head")
    fields = {k: getattr(app, k) for k in DbConfig.model_fields}
    audit = AuditConfig.model_validate(
        fields | {"db_user": "hyd_audit", "db_password_file": db_secrets["audit"]}
    )
    return Accounts(owner, audit, app)


def at(day: date, hour: int = 12) -> datetime:
    return datetime(day.year, day.month, day.day, hour, tzinfo=UTC)


def run[T](config: DbConfig, fn: Callable[[AsyncConnection], Awaitable[T]]) -> T:
    async def main() -> T:
        async with transaction(config) as conn:
            return await fn(conn)

    return asyncio.run(main())


def add(owner: ApiConfig, ts: datetime) -> None:
    """以属主写入指定时间的记录：应用账号不能写 ts。"""
    values = {"ts": ts, "actor": "a", "action": "x", "target": "t", "request_id": ts.isoformat()}
    run(owner, lambda conn: conn.execute(insert(audit_log).values(values)))


@pytest.fixture
def seeded(accounts: Accounts) -> Accounts:
    """D1 两条、D2 无记录、D3 一条，已封存至 D3。"""
    for ts in (at(D1), at(D1, 13), at(D3)):
        add(accounts.owner, ts)
    sealed = run(accounts.audit, lambda conn: seal_pending(conn, at(D3 + DAY, 0) + GRACE))
    assert sealed == [D1, D2, D3]
    return accounts


def test_seals_each_day_including_empty_ones(seeded: Accounts) -> None:
    async def counts(conn: AsyncConnection) -> list[int]:
        return list(
            await conn.scalars(select(audit_seal.c.record_count).order_by(audit_seal.c.day))
        )

    assert run(seeded.audit, counts) == [2, 0, 1]
    assert run(seeded.audit, verify) == []
    assert run(seeded.audit, lambda conn: seal_pending(conn, at(D3 + DAY, 0) + GRACE)) == []


def test_waits_for_grace_after_midnight(accounts: Accounts) -> None:
    add(accounts.owner, at(D1))
    midnight = at(D2, 0)

    early = midnight + GRACE - timedelta(seconds=1)
    assert run(accounts.audit, lambda conn: seal_pending(conn, early)) == []
    assert run(accounts.audit, lambda conn: seal_pending(conn, midnight + GRACE)) == [D1]


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
def test_verify_locates_tampered_day(seeded: Accounts, tamper: str, failed: list[date]) -> None:
    async def bypass_trigger(conn: AsyncConnection) -> None:
        # 只有属主能停用触发器（G-13 迁移 0001）
        await conn.execute(text("ALTER TABLE audit_log DISABLE TRIGGER audit_log_append_only"))
        await conn.execute(text(tamper))
        await conn.execute(text("ALTER TABLE audit_log ENABLE TRIGGER audit_log_append_only"))

    run(seeded.owner, bypass_trigger)

    assert run(seeded.audit, verify) == failed


def test_verify_command_exit_code(seeded: Accounts) -> None:
    audit = seeded.audit
    # 账号默认即 hyd_audit，只需提供连接位置与口令文件
    env = os.environ | {
        "HYD_DB_HOST": audit.db_host,
        "HYD_DB_PORT": str(audit.db_port),
        "HYD_DB_NAME": audit.db_name,
        "HYD_DB_PASSWORD_FILE": str(audit.db_password_file),
    }

    def verify_command() -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["hyd-audit", "verify"], env=env, capture_output=True, text=True, timeout=60
        )

    assert verify_command().returncode == 0
    add(seeded.owner, at(D2))
    result = verify_command()
    assert result.returncode == 1
    assert D2.isoformat() in result.stderr


@pytest.mark.parametrize("sql", ["UPDATE audit_seal SET hash = '\\x00'", "DELETE FROM audit_seal"])
@pytest.mark.parametrize("account", ["owner", "audit", "app"])
def test_seal_records_are_append_only(seeded: Accounts, sql: str, account: str) -> None:
    with pytest.raises(DBAPIError, match="只允许追加|permission denied"):
        run(getattr(seeded, account), lambda conn: conn.execute(text(sql)))
    assert run(seeded.audit, verify) == []


def test_api_server_account_cannot_forge_seals(accounts: Accounts) -> None:
    """api-server 被攻破时不能插入远期封存记录，使后续日期不再封存且无法删除。"""
    forged = {"day": date(2099, 1, 1), "record_count": 0, "prev_hash": b"", "hash": b""}

    with pytest.raises(DBAPIError, match="permission denied"):
        run(accounts.app, lambda conn: conn.execute(insert(audit_seal).values(forged)))
    with pytest.raises(DBAPIError, match="permission denied"):
        run(accounts.app, lambda conn: conn.execute(select(audit_seal)))


@pytest.mark.parametrize(
    "failure",
    [{"db_port": 1, "db_timeout_s": 1}, {"db_name": "missing"}],
    ids=["connection-refused", "rejected-by-database"],  # OSError；DBAPIError
)
def test_seal_once_survives_database_failure_and_catches_up(
    accounts: Accounts, caplog: pytest.LogCaptureFixture, failure: dict
) -> None:
    add(accounts.owner, at(D1))

    with caplog.at_level(logging.INFO, logger="audit_service.cli"):
        asyncio.run(seal_once(accounts.audit.model_copy(update=failure)))
        assert [r.message for r in caplog.records if r.name == "audit_service.cli"] == [
            "audit.seal_failed"
        ]
        caplog.clear()

        asyncio.run(seal_once(accounts.audit))
    sealed = [r.day for r in caplog.records if r.message == "audit.sealed"]
    assert sealed[:3] == [D1.isoformat(), D2.isoformat(), D3.isoformat()]
    assert run(accounts.audit, verify) == []


def test_seal_once_does_not_swallow_unexpected_errors(
    accounts: Accounts, monkeypatch: pytest.MonkeyPatch
) -> None:
    """只有数据库故障可等下个周期重试；程序缺陷须使进程退出、由容器重启暴露。"""

    async def broken(*_: object) -> list[date]:
        raise ValueError("bug")

    monkeypatch.setattr("audit_service.cli.seal_pending", broken)
    with pytest.raises(ValueError, match="bug"):
        asyncio.run(seal_once(accounts.audit))
