"""X-Request-ID 透传（C-BE-08）与统一错误格式（契约 Error）。"""

import io
import json
import logging
import uuid
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from pydantic import BaseModel

from api_server.app import create_app
from api_server.config import ApiConfig
from py_common.log import configure_logging
from py_contracts.api import Error

ROOT = Path(__file__).resolve().parents[3]
SITE, ATTACK = ROOT / "demo/scenarios/site.yaml", ROOT / "rules/attack/techniques.json"


class Body(BaseModel):
    n: int


@pytest.fixture
def client(tmp_path: Path, nats_url: str) -> Iterator[TestClient]:
    (tmp_path / "pw").write_text("unused")
    config = ApiConfig(
        db_password_file=tmp_path / "pw", site_file=SITE, attack_file=ATTACK, nats_url=nats_url
    )
    app = create_app(config)

    @app.post("/t/write")
    async def write(body: Body) -> dict:
        logging.getLogger("t").info("t.write")
        return {"n": body.n}

    @app.get("/t/forbidden")
    async def forbidden() -> None:
        raise HTTPException(403, "角色不足")

    @app.get("/t/crash")
    async def crash() -> None:
        raise RuntimeError("内部缺陷")

    with TestClient(app) as c:
        yield c


def test_write_without_request_id_is_rejected(client: TestClient) -> None:
    r = client.post("/t/write", json={"n": 1})

    assert r.status_code == 400
    body = Error.model_validate(r.json())
    assert body.code == "bad_request"
    assert body.request_id == r.headers["X-Request-ID"]


def test_write_with_empty_request_id_is_rejected(client: TestClient) -> None:
    assert client.post("/t/write", json={"n": 1}, headers={"X-Request-ID": ""}).status_code == 400


def test_request_id_is_echoed_and_bound_to_logs(client: TestClient) -> None:
    stream = io.StringIO()
    configure_logging("api-server", "INFO", stream)

    r = client.post("/t/write", json={"n": 1}, headers={"X-Request-ID": "req-1"})

    assert r.status_code == 200
    assert r.headers["X-Request-ID"] == "req-1"
    entries = [json.loads(line) for line in stream.getvalue().splitlines()]
    assert next(e for e in entries if e["event"] == "t.write")["request_id"] == "req-1"


def test_read_without_request_id_gets_generated_one(client: TestClient) -> None:
    r = client.get("/t/forbidden")

    uuid.UUID(r.headers["X-Request-ID"])
    assert r.json()["request_id"] == r.headers["X-Request-ID"]


@pytest.mark.parametrize(
    ("method", "path", "kwargs", "status", "code"),
    [
        ("get", "/t/forbidden", {}, 403, "forbidden"),
        ("get", "/missing", {}, 404, "not_found"),
        ("post", "/t/write", {"json": {"n": "x"}}, 400, "bad_request"),
    ],
    ids=["http-exception", "unknown-route", "validation"],
)
def test_errors_use_contract_format(
    client: TestClient, method: str, path: str, kwargs: dict, status: int, code: str
) -> None:
    r = client.request(method, path, headers={"X-Request-ID": "req-2"}, **kwargs)

    assert r.status_code == status
    body = Error.model_validate(r.json())
    assert (body.code, body.request_id) == (code, "req-2")


def test_docs_pages_are_disabled(client: TestClient) -> None:
    """自带文档页从公网 CDN 加载脚本（G-05）。"""
    for path in ["/docs", "/redoc", "/openapi.json"]:
        assert client.get(path).status_code == 404


def test_unhandled_error_uses_contract_format_and_is_logged(client: TestClient) -> None:
    stream = io.StringIO()
    configure_logging("api-server", "INFO", stream)

    r = client.get("/t/crash", headers={"X-Request-ID": "req-3"})

    assert r.status_code == 500
    assert r.headers["X-Request-ID"] == "req-3"
    body = Error.model_validate(r.json())
    assert (body.code, body.request_id) == ("internal_server_error", "req-3")
    assert "内部缺陷" not in r.text  # 不向客户端泄露内部细节
    entries = [json.loads(line) for line in stream.getvalue().splitlines()]
    entry = next(e for e in entries if e["event"] == "http.unhandled_error")
    assert entry["request_id"] == "req-3"
    assert "RuntimeError: 内部缺陷" in entry["exc"]
