"""跨服务共用的测试夹具：以 compose.yaml 锁定的镜像启动临时 NATS 与 PostgreSQL。"""

import asyncio
import secrets
import subprocess
import uuid
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path

import nats
import pytest
import yaml
from alembic import command
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from api_server.config import ApiConfig
from api_server.db import alembic_config, create_engine

DEPLOY = Path(__file__).resolve().parent / "deploy/compose"
SITE = Path(__file__).resolve().parent / "demo/scenarios/site.yaml"


def docker(*args: str, check: bool = True) -> str:
    return subprocess.run(
        ["docker", *args], capture_output=True, text=True, timeout=120, check=check
    ).stdout.strip()


def compose_image(service: str) -> str:
    return yaml.safe_load((DEPLOY / "compose.yaml").read_text(encoding="utf-8"))["services"][
        service
    ]["image"]


async def wait_jetstream_ready(url: str, timeout_s: float = 10) -> None:
    """端口可连时 JetStream 可能尚未就绪，以 account_info 成功为准。"""
    async with asyncio.timeout(timeout_s):
        while True:
            try:
                client = await nats.connect(url, allow_reconnect=False, connect_timeout=1)
                try:
                    await client.jetstream().account_info()
                    return
                finally:
                    await client.close()
            except (OSError, nats.errors.Error):
                await asyncio.sleep(0.1)


@contextmanager
def nats_server() -> Iterator[tuple[str, Callable[[], None]]]:
    """返回地址与停止函数；停止后容器即删除。"""
    container = docker(
        "run", "-d", "--rm", "-p", "127.0.0.1::4222", compose_image("nats"), "nats-server", "-js"
    )
    try:
        host, port = docker("port", container, "4222").splitlines()[0].rsplit(":", 1)
        url = f"nats://{host}:{port}"
        asyncio.run(wait_jetstream_ready(url))
        yield url, lambda: docker("rm", "-f", container)
    finally:
        docker("rm", "-f", container, check=False)


@pytest.fixture(scope="session")
def nats_url() -> Iterator[str]:
    with nats_server() as (url, _):
        yield url


@pytest.fixture
def disposable_nats() -> Iterator[tuple[str, Callable[[], None]]]:
    """单个测试独占的 NATS，可在测试中途停止以模拟断线。"""
    with nats_server() as server:
        yield server


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
def db_secrets(tmp_path_factory: pytest.TempPathFactory) -> dict[str, Path]:
    """各数据库账号的口令文件：owner 为属主，app 为 hyd_app，audit 为 hyd_audit。"""
    secrets_dir = tmp_path_factory.mktemp("secrets")
    paths = {name: secrets_dir / name for name in ("owner", "app", "audit")}
    for path in paths.values():
        path.write_text(secrets.token_urlsafe(16))
    return paths


@pytest.fixture(scope="session")
def db(db_secrets: dict[str, Path], nats_url: str) -> Iterator[tuple[ApiConfig, ApiConfig]]:
    """返回（属主配置，应用配置），数据库已迁移至最新版本；配置同时指向临时 NATS。"""
    owner_pw, app_pw = db_secrets["owner"], db_secrets["app"]
    container = docker(
        "run", "-d", "--rm", "-p", "127.0.0.1::5432",
        "-e", f"POSTGRES_PASSWORD={owner_pw.read_text()}", "-e", "POSTGRES_DB=hyd",
        "-v", f"{DEPLOY / 'postgres-init'}:/docker-entrypoint-initdb.d:ro",
        "-v", f"{app_pw}:/run/secrets/db_app_password:ro",
        "-v", f"{db_secrets['audit']}:/run/secrets/db_audit_password:ro",
        compose_image("postgres"),
    )  # fmt: skip
    try:
        host, port = docker("port", container, "5432").splitlines()[0].rsplit(":", 1)
        base = {
            "db_host": host,
            "db_port": int(port),
            "db_timeout_s": 5,
            "site_file": SITE,
            "nats_url": nats_url,
        }
        owner = ApiConfig.model_validate(
            base | {"db_user": "postgres", "db_password_file": owner_pw}
        )
        app = ApiConfig.model_validate(base | {"db_password_file": app_pw})
        asyncio.run(wait_ready(app))
        command.upgrade(alembic_config(owner), "head")
        yield owner, app
    finally:
        docker("rm", "-f", "-v", container, check=False)  # -v：同时删除镜像声明的数据卷


async def autocommit(config: ApiConfig, sql: str) -> None:
    engine = create_engine(config)
    try:
        async with engine.connect() as conn:
            await conn.execution_options(isolation_level="AUTOCOMMIT")
            await conn.execute(text(sql))
    finally:
        await engine.dispose()


@pytest.fixture
def scratch_db(db: tuple[ApiConfig, ApiConfig]) -> Iterator[tuple[ApiConfig, ApiConfig]]:
    """同一实例中的空数据库（未迁移），用例结束即删除；用于不能与其他用例共享数据的场景。"""
    owner, app = db
    name = f"scratch_{uuid.uuid4().hex[:8]}"
    asyncio.run(autocommit(owner, f"CREATE DATABASE {name}"))
    try:
        yield owner.model_copy(update={"db_name": name}), app.model_copy(update={"db_name": name})
    finally:
        asyncio.run(autocommit(owner, f"DROP DATABASE {name}"))
