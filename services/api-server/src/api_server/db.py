"""数据库连接与迁移入口（C-ST-01）。"""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from alembic.config import Config
from sqlalchemy import URL
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine, create_async_engine

from api_server.config import ApiConfig

MIGRATIONS = Path(__file__).parent / "migrations"


def create_engine(config: ApiConfig) -> AsyncEngine:
    url = URL.create(
        "postgresql+asyncpg",
        username=config.db_user,
        password=config.db_password_file.read_text(encoding="utf-8").strip(),
        host=config.db_host,
        port=config.db_port,
        database=config.db_name,
    )
    return create_async_engine(
        url,
        pool_timeout=config.db_timeout_s,
        connect_args={"timeout": config.db_timeout_s, "command_timeout": config.db_timeout_s},
    )


@asynccontextmanager
async def transaction(config: ApiConfig) -> AsyncIterator[AsyncConnection]:
    """一次性连接上的单个事务，供命令行等服务进程之外的调用方使用。"""
    engine = create_engine(config)
    try:
        async with engine.begin() as conn:
            yield conn
    finally:
        await engine.dispose()


def alembic_config(config: ApiConfig) -> Config:
    """迁移以属主账号执行：config 的 db_user 与 db_password_file 须指向属主。"""
    cfg = Config()
    cfg.set_main_option("script_location", str(MIGRATIONS))
    cfg.attributes["config"] = config
    return cfg
