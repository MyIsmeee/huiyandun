"""本地账户登录、会话与 RBAC（C-BE-07）。会话令牌只经 HttpOnly Cookie 传递（C-FE-06）。"""

import asyncio
import hashlib
import logging
import os
import secrets
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from functools import cache
from typing import Annotated

from cryptography.exceptions import InvalidKey
from cryptography.hazmat.primitives.kdf.argon2 import Argon2id
from fastapi import APIRouter, Depends, Request, Response
from sqlalchemy import Column, DateTime, LargeBinary, MetaData, Table, Text, delete, insert, select
from sqlalchemy.ext.asyncio import AsyncEngine
from starlette.exceptions import HTTPException

from py_contracts.api import LoginRequest, LoginResponse, Session

log = logging.getLogger(__name__)

COOKIE = "hyd_session"
ROLES = ("viewer", "operator", "admin", "auditor")
# 角色包含关系（HYD-PLAN-007 §3）：viewer ⊂ operator ⊂ admin，viewer ⊂ auditor
GRANTED = {
    "viewer": frozenset(ROLES),
    "operator": frozenset({"operator", "admin"}),
    "admin": frozenset({"admin"}),
    "auditor": frozenset({"auditor"}),
}

# 表结构由迁移 0002 定义
metadata = MetaData()
users = Table(
    "users",
    metadata,
    Column("username", Text, primary_key=True),
    Column("password_hash", Text),
    Column("role", Text),
)
sessions = Table(
    "sessions",
    metadata,
    Column("token_hash", LargeBinary, primary_key=True),
    Column("username", Text),
    Column("expires_at", DateTime(timezone=True)),
)


def hash_password(password: str) -> str:
    # RFC 9106 第二推荐参数：t=3、64 MiB、p=4
    kdf = Argon2id(salt=os.urandom(16), length=32, iterations=3, lanes=4, memory_cost=64 * 1024)
    return kdf.derive_phc_encoded(password.encode())


def verify_password(password: str, encoded: str) -> bool:
    try:
        Argon2id.verify_phc_encoded(password.encode(), encoded)
    except InvalidKey:
        return False
    return True


@cache
def _dummy_hash() -> str:
    """账号不存在时也校验一次，响应耗时不泄露账号是否存在。"""
    return hash_password(secrets.token_urlsafe())


def _token_hash(token: str) -> bytes:
    return hashlib.sha256(token.encode()).digest()


@dataclass(frozen=True)
class Principal:
    username: str
    role: str
    token_hash: bytes
    expires_at: datetime


async def lookup_session(engine: AsyncEngine, token: str | None) -> Principal | None:
    if not token:
        return None
    token_hash = _token_hash(token)
    query = (
        select(users.c.username, users.c.role, sessions.c.expires_at)
        .join(sessions, sessions.c.username == users.c.username)
        .where(sessions.c.token_hash == token_hash, sessions.c.expires_at > datetime.now(UTC))
    )
    async with engine.connect() as conn:
        row = (await conn.execute(query)).first()
    return Principal(row.username, row.role, token_hash, row.expires_at) if row else None


async def authenticate(request: Request) -> Principal:
    principal = await lookup_session(request.app.state.engine, request.cookies.get(COOKIE))
    if principal is None:
        raise HTTPException(401, "未登录或会话失效")
    return principal


def require(min_role: str) -> Callable[[Principal], Awaitable[Principal]]:
    async def check(principal: Annotated[Principal, Depends(authenticate)]) -> Principal:
        if principal.role not in GRANTED[min_role]:
            raise HTTPException(403, "角色不足")
        return principal

    return check


router = APIRouter(prefix="/api/auth")


@router.post("/login")
async def login(body: LoginRequest, request: Request, response: Response) -> LoginResponse:
    engine: AsyncEngine = request.app.state.engine
    async with engine.connect() as conn:
        row = (
            await conn.execute(
                select(users.c.password_hash, users.c.role).where(users.c.username == body.username)
            )
        ).first()
    encoded = row.password_hash if row else await asyncio.to_thread(_dummy_hash)
    valid = await asyncio.to_thread(verify_password, body.password.get_secret_value(), encoded)
    if not (row and valid):
        log.warning("auth.login_failed", extra={"username": body.username})
        raise HTTPException(401, "用户名或口令错误")

    ttl_s = request.app.state.config.session_ttl_s
    token = secrets.token_urlsafe(32)
    expires_at = datetime.now(UTC) + timedelta(seconds=ttl_s)
    async with engine.begin() as conn:
        await conn.execute(delete(sessions).where(sessions.c.expires_at <= datetime.now(UTC)))
        await conn.execute(
            insert(sessions).values(
                token_hash=_token_hash(token), username=body.username, expires_at=expires_at
            )
        )
    response.set_cookie(
        COOKIE, token, max_age=ttl_s, path="/", secure=True, httponly=True, samesite="strict"
    )
    log.info("auth.login", extra={"username": body.username})
    return LoginResponse.model_validate({"role": row.role, "expires_at": expires_at})


@router.get("/session")
async def session(principal: Annotated[Principal, Depends(authenticate)]) -> Session:
    """页面刷新后据此决定渲染哪些操作（C-FE-07）。"""
    return Session.model_validate(
        {"username": principal.username, "role": principal.role, "expires_at": principal.expires_at}
    )


@router.post("/logout", status_code=204)
async def logout(
    request: Request, response: Response, principal: Annotated[Principal, Depends(authenticate)]
) -> None:
    async with request.app.state.engine.begin() as conn:
        await conn.execute(delete(sessions).where(sessions.c.token_hash == principal.token_hash))
    request.app.state.hub.disconnect_session(principal.token_hash)
    response.delete_cookie(COOKIE, path="/", secure=True, httponly=True, samesite="strict")
