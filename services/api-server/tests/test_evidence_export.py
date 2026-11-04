"""导出证据包（FR-702、TK-080）：角色、经 evidence-service 取包、审计后才返回、不可达提示。"""

import asyncio
import hashlib
from collections.abc import Callable, Iterator

import httpx2
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.exc import OperationalError

from api_server import evidence
from api_server.app import create_app
from api_server.audit import audit_log
from api_server.config import ApiConfig
from api_server.db import transaction

PACKAGE = b"PK\x03\x04evidence"
URL = "/api/incidents/inc-ev/evidence/export"

type Handler = Callable[[httpx2.Request], httpx2.Response]


@pytest.fixture
def client(db: tuple[ApiConfig, ApiConfig]) -> Iterator[TestClient]:
    with TestClient(create_app(db[1]), base_url="https://testserver") as c:
        yield c


def login(client: TestClient, role: str, password: str) -> None:
    body = {"username": role, "password": password}
    assert (
        client.post("/api/auth/login", json=body, headers={"X-Request-ID": "r"}).status_code == 200
    )


def evidence_service(client: TestClient, handler: Handler) -> list[httpx2.Request]:
    """以假 evidence-service 替换真实连接，返回其收到的请求。"""
    seen: list[httpx2.Request] = []

    def record(request: httpx2.Request) -> httpx2.Response:
        seen.append(request)
        return handler(request)

    state = client.app.state
    state.evidence = httpx2.AsyncClient(
        base_url=state.config.evidence_url, transport=httpx2.MockTransport(record)
    )
    return seen


def audited(config: ApiConfig, request_id: str) -> list[tuple]:
    async def query() -> list[tuple]:
        async with transaction(config) as conn:
            rows = await conn.execute(
                select(audit_log.c.actor, audit_log.c.action, audit_log.c.target, audit_log.c.after)
                .where(audit_log.c.request_id == request_id)
            )  # fmt: skip
            return [tuple(r) for r in rows]

    return asyncio.run(query())


def test_viewer_cannot_export(client: TestClient, password: str) -> None:
    login(client, "viewer", password)
    seen = evidence_service(client, lambda _: httpx2.Response(200, content=PACKAGE))

    assert client.post(URL, headers={"X-Request-ID": "r"}).status_code == 403
    assert seen == []


def test_package_returned_after_audit(
    client: TestClient, password: str, db: tuple[ApiConfig, ApiConfig]
) -> None:
    login(client, "operator", password)
    seen = evidence_service(client, lambda _: httpx2.Response(200, content=PACKAGE))

    res = client.post(URL, headers={"X-Request-ID": "req-export"})

    assert res.status_code == 200
    assert res.content == PACKAGE
    assert res.headers["content-disposition"] == 'attachment; filename="evidence-inc-ev.zip"'
    [request] = seen
    assert request.url.path == "/internal/incidents/inc-ev/package"
    assert audited(db[1], "req-export") == [
        (
            "operator",
            "evidence.exported",
            "inc-ev",
            {"sha256": hashlib.sha256(PACKAGE).hexdigest(), "bytes": len(PACKAGE)},
        )
    ]


def test_incident_without_evidence_is_not_found(
    client: TestClient, password: str, db: tuple[ApiConfig, ApiConfig]
) -> None:
    login(client, "operator", password)
    evidence_service(client, lambda _: httpx2.Response(404))

    assert client.post(URL, headers={"X-Request-ID": "req-missing"}).status_code == 404
    assert audited(db[1], "req-missing") == []


@pytest.mark.parametrize("failure", ["refused", "error"])
def test_evidence_service_unavailable(
    client: TestClient, password: str, db: tuple[ApiConfig, ApiConfig], failure: str
) -> None:
    def handler(request: httpx2.Request) -> httpx2.Response:
        if failure == "refused":
            raise httpx2.ConnectError("refused", request=request)
        return httpx2.Response(500)

    login(client, "operator", password)
    evidence_service(client, handler)

    res = client.post(URL, headers={"X-Request-ID": "req-down"})

    assert res.status_code == 503
    assert res.json()["message"] == "存证服务暂不可达，请稍后重试"
    assert audited(db[1], "req-down") == []


def test_audit_failure_withholds_package(
    client: TestClient, password: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """G-13：写审计失败时不交出证据包。"""
    login(client, "operator", password)
    evidence_service(client, lambda _: httpx2.Response(200, content=PACKAGE))

    async def broken(*args: object, **kwargs: object) -> None:
        raise OperationalError("insert", {}, Exception("connection lost"))

    monkeypatch.setattr(evidence, "record", broken)

    res = client.post(URL, headers={"X-Request-ID": "r"})

    assert res.status_code == 500
    assert PACKAGE not in res.content
