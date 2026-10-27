"""命令行入口 hyd-api。

- serve：启动服务；
- migrate：以属主账号执行数据库迁移；
- create-user：创建本地账户，口令交互输入、不落文件（G-14），并写审计（G-13）。M0 不做网页端账号管理。
"""

import argparse
import asyncio
import getpass
import sys
import uuid

import uvicorn
from alembic import command
from sqlalchemy import insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncConnection

from api_server import audit
from api_server.app import create_app
from api_server.auth import ROLES, hash_password, users
from api_server.config import ApiConfig
from api_server.db import alembic_config, transaction
from api_server.site import SiteError
from py_common.config import load_config
from py_common.log import configure_logging

MIN_PASSWORD_LENGTH = 8  # NIST SP 800-63B 下限


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


def main() -> None:
    parser = argparse.ArgumentParser(prog="hyd-api")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("serve")
    commands.add_parser("migrate")
    create = commands.add_parser("create-user")
    create.add_argument("username")
    create.add_argument("--role", required=True, choices=ROLES)
    args = parser.parse_args()

    config = load_config(ApiConfig)
    configure_logging("api-server", config.log_level)
    if args.command == "migrate":
        command.upgrade(alembic_config(config), "head")
    elif args.command == "create-user":
        asyncio.run(_create_user(config, args.username, args.role, _read_password()))
    else:
        try:
            app = create_app(config)
        except SiteError as e:
            sys.exit(str(e))
        # log_config=None：uvicorn 的日志沿用根 logger 的 JSON 格式（CD-06）
        uvicorn.run(app, host="0.0.0.0", port=config.port, log_config=None)
