"""数据库连接与迁移入口（C-ST-01）。"""

from pathlib import Path

from alembic.config import Config
from sqlalchemy import URL
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

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
    # 单条语句与事务内空闲各受 db_timeout_s 约束（PostgreSQL 16 没有整个事务的时长上限）
    idle_ms = str(int(config.db_timeout_s * 1000))
    return create_async_engine(
        url,
        pool_timeout=config.db_timeout_s,
        connect_args={
            "timeout": config.db_timeout_s,
            "command_timeout": config.db_timeout_s,
            "server_settings": {"idle_in_transaction_session_timeout": idle_ms},
        },
    )


def alembic_config(config: ApiConfig) -> Config:
    """迁移以属主账号执行：config 的 db_user 与 db_password_file 须指向属主。"""
    cfg = Config()
    cfg.set_main_option("script_location", str(MIGRATIONS))
    cfg.attributes["config"] = config
    return cfg
