"""以 compose.yaml 锁定的镜像与 postgres-init 脚本启动临时 PostgreSQL，执行迁移，测试结束即删除。"""

import asyncio
import secrets
import subprocess
from collections.abc import Iterator
from pathlib import Path

import pytest
import yaml
from alembic import command
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from api_server.config import ApiConfig
from api_server.db import alembic_config, create_engine

DEPLOY = Path(__file__).resolve().parents[3] / "deploy/compose"


def docker(*args: str, check: bool = True) -> str:
    return subprocess.run(
        ["docker", *args], capture_output=True, text=True, timeout=120, check=check
    ).stdout.strip()


async def wait_ready(config: ApiConfig, timeout_s: float = 60) -> None:
    """初始化期间的临时实例只监听 socket，正式实例启动初期拒绝连接；以应用账号查询成功为准。"""
    async with asyncio.timeout(timeout_s):
        while True:
            engine = create_engine(config)
            try:
                async with engine.connect() as conn:
                    await conn.execute(text("SELECT 1"))
                    return
            except (OSError, DBAPIError):
                await asyncio.sleep(0.2)
            finally:
                await engine.dispose()


@pytest.fixture(scope="session")
def db(tmp_path_factory: pytest.TempPathFactory) -> Iterator[tuple[ApiConfig, ApiConfig]]:
    """返回（属主配置，应用配置），数据库已迁移至最新版本。"""
    secrets_dir = tmp_path_factory.mktemp("secrets")
    owner_pw, app_pw = secrets_dir / "owner", secrets_dir / "app"
    owner_pw.write_text(secrets.token_urlsafe(16))
    app_pw.write_text(secrets.token_urlsafe(16))
    image = yaml.safe_load((DEPLOY / "compose.yaml").read_text(encoding="utf-8"))["services"][
        "postgres"
    ]["image"]
    container = docker(
        "run", "-d", "--rm", "-p", "127.0.0.1::5432",
        "-e", f"POSTGRES_PASSWORD={owner_pw.read_text()}", "-e", "POSTGRES_DB=hyd",
        "-v", f"{DEPLOY / 'postgres-init'}:/docker-entrypoint-initdb.d:ro",
        "-v", f"{app_pw}:/run/secrets/db_app_password:ro",
        image,
    )  # fmt: skip
    try:
        host, port = docker("port", container, "5432").splitlines()[0].rsplit(":", 1)
        base = {"db_host": host, "db_port": int(port), "db_timeout_s": 5}
        owner = ApiConfig.model_validate(
            base | {"db_user": "postgres", "db_password_file": owner_pw}
        )
        app = ApiConfig.model_validate(base | {"db_password_file": app_pw})
        asyncio.run(wait_ready(app))
        command.upgrade(alembic_config(owner), "head")
        yield owner, app
    finally:
        docker("rm", "-f", container, check=False)
