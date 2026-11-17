"""命令行入口 hyd-api。

- serve：启动服务；
- migrate：以属主账号执行数据库迁移；
- create-user：创建本地账户，口令交互输入、不落文件（G-14），并写审计（G-13）。M0 不做网页端账号管理；
- demo-reset：演示复位，回滚仍在生效的处置并清空关联引擎的去重期，使攻击可立即重演（make demo-reset）。
"""

import argparse
import asyncio
import getpass
import sys
import uuid
from datetime import UTC, datetime

import uvicorn
from alembic import command
from sqlalchemy import insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncConnection

from api_server import audit
from api_server.app import create_app
from api_server.auth import ROLES, hash_password, users
from api_server.config import ApiConfig
from api_server.containment import ROLLBACK_SUBJECT
from api_server.db import alembic_config, transaction
from api_server.history import WINDOW
from api_server.site import SiteError
from py_common.bus import Bus
from py_common.config import load_config
from py_common.log import configure_logging
from py_contracts.events.hyd_demo_reset_v1_schema import DemoResetV1
from py_contracts.events.hyd_playbook_execution_v1_schema import PlaybookExecutionV1
from py_contracts.events.hyd_playbook_rollback_v1_schema import PlaybookRollbackV1

MIN_PASSWORD_LENGTH = 8  # NIST SP 800-63B 下限
EXECUTION_SUBJECT = "hyd.playbook.execution.v1"
RESET_SUBJECT = "hyd.demo.reset.v1"
RESET_ACTOR = "demo-reset"


async def create_user(
    conn: AsyncConnection, *, username: str, password: str, role: str, request_id: str
) -> None:
    """账户与审计记录在同一事务内写入。"""
    password_hash = await asyncio.to_thread(hash_password, password)
    await conn.execute(
        insert(users).values(username=username, password_hash=password_hash, role=role)
    )
    await audit.record(
        conn,
        actor="cli",
        action="user.create",
        target=username,
        before=None,
        after={"username": username, "role": role},
        request_id=request_id,
    )


def _read_password() -> str:
    password = getpass.getpass("口令：")
    if len(password) < MIN_PASSWORD_LENGTH:
        sys.exit(f"口令至少 {MIN_PASSWORD_LENGTH} 个字符")
    if getpass.getpass("再次输入口令：") != password:
        sys.exit("两次输入的口令不一致")
    return password


async def _create_user(config: ApiConfig, username: str, role: str, password: str) -> None:
    try:
        async with transaction(config) as conn:
            await create_user(
                conn, username=username, password=password, role=role, request_id=str(uuid.uuid4())
            )
    except IntegrityError:
        sys.exit(f"账户 {username} 已存在")


async def demo_reset(config: ApiConfig, bus: Bus) -> list[str]:
    """回滚近 24 小时内仍为 contained 的处置（与控制台手动回滚同一请求，逐条审计），再广播复位使
    correlator 清空去重期。返回发出回滚的执行编号。"""
    latest: dict[str, PlaybookExecutionV1] = {}

    async def on_execution(execution: PlaybookExecutionV1) -> None:
        latest[execution.id] = execution  # 流内按时间先后，后到的即最新状态

    await bus.js_subscribe(
        EXECUTION_SUBJECT, PlaybookExecutionV1, on_execution, datetime.now(UTC) - WINDOW
    )
    request_id = str(uuid.uuid4())
    rolled_back = []
    for execution in [e for e in latest.values() if e.state == "contained"]:
        # 先写审计后发布：审计失败则不回滚，与 POST /api/executions/{id}/rollback 一致
        async with transaction(config) as conn:
            await audit.record(
                conn,
                actor=RESET_ACTOR,
                action="playbook.rollback_requested",
                target=execution.target,
                before={"execution_id": execution.id, "state": execution.state},
                after=None,
                request_id=request_id,
            )
            await bus.js_publish(
                ROLLBACK_SUBJECT,
                PlaybookRollbackV1(
                    schema_version="1.0.0",
                    event_id=uuid.uuid4(),
                    ts=datetime.now(UTC),
                    execution_id=execution.id,
                    actor=RESET_ACTOR,
                    request_id=request_id,
                ),
            )
        rolled_back.append(execution.id)
    async with transaction(config) as conn:
        await audit.record(
            conn,
            actor=RESET_ACTOR,
            action="demo.reset",
            target="correlator",
            before=None,
            after={"rolled_back": rolled_back},
            request_id=request_id,
        )
    await bus.publish(
        RESET_SUBJECT,
        DemoResetV1(
            schema_version="1.0.0",
            event_id=uuid.uuid4(),
            ts=datetime.now(UTC),
            actor=RESET_ACTOR,
            request_id=request_id,
        ),
    )
    return rolled_back


async def _demo_reset(config: ApiConfig) -> None:
    bus = await Bus.connect(config.nats_url, name="api-demo-reset", timeout_s=config.nats_timeout_s)
    try:
        rolled_back = await demo_reset(config, bus)
    finally:
        await bus.close()
    print(f"已回滚 {len(rolled_back)} 项处置，关联引擎去重期已清空")


def main() -> None:
    parser = argparse.ArgumentParser(prog="hyd-api")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("serve")
    commands.add_parser("migrate")
    create = commands.add_parser("create-user")
    create.add_argument("username")
    create.add_argument("--role", required=True, choices=ROLES)
    commands.add_parser("demo-reset")
    args = parser.parse_args()

    config = load_config(ApiConfig)
    configure_logging("api-server", config.log_level)
    if args.command == "migrate":
        command.upgrade(alembic_config(config), "head")
    elif args.command == "create-user":
        asyncio.run(_create_user(config, args.username, args.role, _read_password()))
    elif args.command == "demo-reset":
        asyncio.run(_demo_reset(config))
    else:
        try:
            app = create_app(config)
        except SiteError as e:
            sys.exit(str(e))
        # log_config=None：uvicorn 的日志沿用根 logger 的 JSON 格式（CD-06）
        uvicorn.run(app, host="0.0.0.0", port=config.port, log_config=None)
