"""C-ST-01：每个迁移可 upgrade → downgrade → upgrade。在独立数据库中进行，不影响其他用例的数据。"""

import asyncio

from alembic import command
from sqlalchemy import text

from api_server.config import ApiConfig
from api_server.db import alembic_config, transaction


def test_upgrade_downgrade_upgrade(scratch_db: tuple[ApiConfig, ApiConfig]) -> None:
    owner, app = scratch_db
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

    assert {"audit_log", "users", "sessions", "audit_seal"} <= asyncio.run(tables())
