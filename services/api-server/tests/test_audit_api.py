"""GET /api/audit-logs 与命令行创建账户（G-13、C-BE-07）。"""

import asyncio
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from api_server import cli
from api_server.app import create_app
from api_server.audit import record
from api_server.auth import ROLES, users
from api_server.config import ApiConfig
from api_server.db import transaction
from py_contracts.api import AuditLogList


@pytest.fixture
def client(db: tuple[ApiConfig, ApiConfig], password: str) -> Iterator[TestClient]:
    with TestClient(create_app(db[1]), base_url="https://testserver") as c:
        yield c


def login(client: TestClient, username: str, password: str) -> int:
    body = {"username": username, "password": password}
    return client.post("/api/auth/login", json=body, headers={"X-Request-ID": "r"}).status_code


@pytest.fixture
def auditor(client: TestClient, password: str) -> TestClient:
    login(client, "auditor", password)
    return client


def list_logs(client: TestClient, **params: str | int) -> AuditLogList:
    r = client.get("/api/audit-logs", params=params)
    assert r.status_code == 200
    return AuditLogList.model_validate(r.json())


@pytest.mark.parametrize("role", ROLES)
def test_only_auditor_reads_audit_logs(client: TestClient, password: str, role: str) -> None:
    login(client, role, password)

    assert client.get("/api/audit-logs").status_code == (200 if role == "auditor" else 403)


def test_newest_first_with_limit_and_before(
    auditor: TestClient, db: tuple[ApiConfig, ApiConfig]
) -> None:
    async def append(request_id: str) -> None:
        async with transaction(db[1]) as conn:
            await record(
                conn, actor="a", action="x", target="t", before=None, after=None,
                request_id=request_id,
            )  # fmt: skip

    for i in range(3):
        asyncio.run(append(f"page-{i}"))

    newest = list_logs(auditor, limit=2).items
    assert [e.request_id for e in newest] == ["page-2", "page-1"]
    older = list_logs(auditor, limit=1, before=newest[0].ts.isoformat()).items
    assert [e.request_id for e in older] == ["page-1"]


@pytest.mark.parametrize("limit", [0, 201])
def test_rejects_limit_out_of_range(auditor: TestClient, limit: int) -> None:
    assert auditor.get("/api/audit-logs", params={"limit": limit}).status_code == 400


def test_created_user_is_audited_and_can_log_in(
    auditor: TestClient, db: tuple[ApiConfig, ApiConfig]
) -> None:
    asyncio.run(cli._create_user(db[1], "new-operator", "operator", "new-pass-123"))

    entry = next(e for e in list_logs(auditor).items if e.target == "new-operator")
    assert (entry.actor, entry.action, entry.before) == ("cli", "user.create", None)
    assert entry.after == {"username": "new-operator", "role": "operator"}
    assert login(auditor, "new-operator", "new-pass-123") == 200

    async def stored_hash() -> str:
        async with transaction(db[1]) as conn:
            query = select(users.c.password_hash).where(users.c.username == "new-operator")
            return await conn.scalar(query)

    encoded = asyncio.run(stored_hash())
    assert encoded.startswith("$argon2id$") and "new-pass-123" not in encoded


def test_create_user_rejects_duplicate_without_audit(
    auditor: TestClient, db: tuple[ApiConfig, ApiConfig]
) -> None:
    before = len(list_logs(auditor, limit=200).items)

    with pytest.raises(SystemExit, match="已存在"):
        asyncio.run(cli._create_user(db[1], "admin", "viewer", "another-pass"))
    assert len(list_logs(auditor, limit=200).items) == before


@pytest.mark.parametrize(
    ("inputs", "message"),
    [(["short"], "至少 8"), (["long-enough-1", "long-enough-2"], "不一致")],
    ids=["too-short", "mismatch"],
)
def test_password_prompt_validation(
    monkeypatch: pytest.MonkeyPatch, inputs: list[str], message: str
) -> None:
    answers = iter(inputs)
    monkeypatch.setattr(cli.getpass, "getpass", lambda _prompt: next(answers))

    with pytest.raises(SystemExit, match=message):
        cli._read_password()
