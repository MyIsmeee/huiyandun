"""登录、会话与 RBAC（C-BE-07）；凭证只在 HttpOnly Cookie 中（C-FE-06）。"""

import asyncio
from collections.abc import Iterator

import httpx2
import pytest
from fastapi import Depends
from fastapi.testclient import TestClient
from sqlalchemy import text

from api_server.app import create_app
from api_server.auth import ROLES, require, verify_password
from api_server.config import ApiConfig
from api_server.db import transaction
from py_contracts.api import Error, LoginResponse

RID = {"X-Request-ID": "req-auth"}
# cryptography 47.0.0 以 hash_password 的参数生成；口令 legacy-pass-1 仅用于本测试
LEGACY_HASH = (
    "$argon2id$v=19$m=65536,t=3,p=4$optaESX4KEG8UhucRQ1oEw"
    "$G0IdQX27ZzmJx1ZDiUvF+ZrVDvkvENxU343bXFzyQ0I"
)
# HYD-PLAN-007 §3：viewer ⊂ operator ⊂ admin，viewer ⊂ auditor
ALLOWED = {
    ("viewer", "viewer"), ("viewer", "operator"), ("viewer", "admin"), ("viewer", "auditor"),
    ("operator", "operator"), ("operator", "admin"),
    ("admin", "admin"),
    ("auditor", "auditor"),
}  # fmt: skip


@pytest.fixture
def client(db: tuple[ApiConfig, ApiConfig], password: str) -> Iterator[TestClient]:
    app = create_app(db[1])
    for min_role in ROLES:
        app.get(f"/t/{min_role}", dependencies=[Depends(require(min_role))])(lambda: None)
    # Secure Cookie 只经 HTTPS 发送
    with TestClient(app, base_url="https://testserver") as c:
        yield c


def login(client: TestClient, username: str, password: str) -> httpx2.Response:
    body = {"username": username, "password": password}
    return client.post("/api/auth/login", json=body, headers=RID)


def test_login_sets_http_only_cookie(client: TestClient, password: str) -> None:
    r = login(client, "admin", password)

    assert r.status_code == 200
    assert LoginResponse.model_validate(r.json()).role.root == "admin"
    cookie = r.headers["set-cookie"]
    token = cookie.split(";")[0].removeprefix("hyd_session=")
    assert token and token not in r.text
    for attribute in ["httponly", "secure", "samesite=strict", "path=/"]:
        assert attribute in cookie.lower()


@pytest.mark.parametrize("username", ["admin", "nobody"], ids=["wrong-password", "unknown-user"])
def test_login_rejects_bad_credentials(client: TestClient, password: str, username: str) -> None:
    r = login(client, username, password + "x")

    assert r.status_code == 401
    assert Error.model_validate(r.json()).code == "unauthorized"
    assert "set-cookie" not in r.headers


def test_requests_without_session_are_unauthorized(client: TestClient) -> None:
    assert client.get("/t/viewer").status_code == 401
    assert client.post("/api/auth/logout", headers=RID).status_code == 401


@pytest.mark.parametrize("role", ROLES)
@pytest.mark.parametrize("min_role", ROLES)
def test_role_inclusion(client: TestClient, password: str, min_role: str, role: str) -> None:
    login(client, role, password)

    expected = 200 if (min_role, role) in ALLOWED else 403
    assert client.get(f"/t/{min_role}").status_code == expected


def test_logout_revokes_session(client: TestClient, password: str) -> None:
    login(client, "auditor", password)
    token = client.cookies["hyd_session"]

    r = client.post("/api/auth/logout", headers=RID)

    assert r.status_code == 204
    assert "hyd_session" not in client.cookies
    # 在浏览器之外重放旧令牌
    replay = client.get("/t/viewer", headers={"Cookie": f"hyd_session={token}"})
    assert replay.status_code == 401


def test_expired_session_is_rejected(
    client: TestClient, password: str, db: tuple[ApiConfig, ApiConfig]
) -> None:
    login(client, "auditor", password)

    async def expire() -> None:
        async with transaction(db[0]) as conn:
            await conn.execute(text("UPDATE sessions SET expires_at = now() - interval '1 second'"))

    asyncio.run(expire())
    assert client.get("/t/viewer").status_code == 401


def test_healthz_checks_database_without_login(client: TestClient) -> None:
    client.cookies.clear()

    assert client.get("/healthz").status_code == 204


def test_verifies_hash_from_earlier_cryptography_release() -> None:
    """升级 cryptography 后，已有账户的口令哈希仍能校验，账户仍能登录。"""
    assert verify_password("legacy-pass-1", LEGACY_HASH)
    assert not verify_password("legacy-pass-2", LEGACY_HASH)
