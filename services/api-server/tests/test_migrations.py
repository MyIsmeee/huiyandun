"""C-ST-01：每个迁移可 upgrade → downgrade → upgrade。在独立数据库中进行，不影响其他用例的数据。"""

import asyncio
from collections.abc import Iterator

import pytest
from alembic import command
from sqlalchemy import text

from api_server.config import ApiConfig
from api_server.db import alembic_config, create_engine, transaction


async def autocommit(config: ApiConfig, sql: str) -> None:
    engine = create_engine(config)
    try:
        async with engine.connect() as conn:
            await conn.execution_options(isolation_level="AUTOCOMMIT")
            await conn.execute(text(sql))
    finally:
        await engine.dispose()


@pytest.fixture
def scratch(db: tuple[ApiConfig, ApiConfig]) -> Iterator[tuple[ApiConfig, ApiConfig]]:
    owner, app = db
    asyncio.run(autocommit(owner, "CREATE DATABASE migration_check"))
    try:
        yield tuple(c.model_copy(update={"db_name": "migration_check"}) for c in (owner, app))
    finally:
        asyncio.run(autocommit(owner, "DROP DATABASE migration_check"))


def test_upgrade_downgrade_upgrade(scratch: tuple[ApiConfig, ApiConfig]) -> None:
    owner, app = scratch
    cfg = alembic_config(owner)

    command.upgrade(cfg, "head")
    command.downgrade(cfg, "base")
    command.upgrade(cfg, "head")

    async def tables() -> set[str]:
        async with transaction(app) as conn:
            rows = await conn.execute(
                text("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")
            )
            return {r[0] for r in rows}

    assert {"audit_log", "users", "sessions"} <= asyncio.run(tables())
