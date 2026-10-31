"""模型供应商管理（FR-601、FR-603～FR-605、TK-060）：角色、公网默认停用、网络位置、Key 加密、排序与审计。"""

import asyncio
import base64
import os
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import delete, select, update

from api_server import llm
from api_server.app import create_app
from api_server.audit import audit_log
from api_server.config import ApiConfig
from api_server.db import transaction

KEY = "sk-not-a-real-key-7f3a"
LAN = {"name": "家用 5070", "preset": "llama_cpp", "base_url": "http://192.168.1.50:8888/v1"}
CLOUD = {"name": "DeepSeek", "preset": "deepseek", "base_url": "https://api.deepseek.com/v1"}
rid = iter(range(10**6))


def headers() -> dict[str, str]:
    return {"X-Request-ID": f"req-llm-{next(rid)}"}


@pytest.fixture
def key_file(tmp_path: Path) -> Path:
    path = tmp_path / "llm_key_secret"
    path.write_text(base64.b64encode(os.urandom(32)).decode())
    return path


@pytest.fixture
def client(db: tuple[ApiConfig, ApiConfig], password: str, key_file: Path) -> Iterator[TestClient]:
    async def reset() -> None:
        async with transaction(db[1]) as conn:
            await conn.execute(delete(llm.providers))
            await conn.execute(update(llm.settings).values(block_public=False))

    asyncio.run(reset())
    config = db[1].model_copy(update={"llm_key_file": key_file})
    with TestClient(create_app(config), base_url="https://testserver") as c:
        body = {"username": "admin", "password": password}
        assert c.post("/api/auth/login", json=body, headers=headers()).status_code == 200
        yield c


def create(client: TestClient, base: dict, **extra: object) -> dict:
    r = client.post("/api/llm/providers", json=base | {"model": "m"} | extra, headers=headers())
    assert r.status_code == 201, r.text
    return r.json()


def stored(config: ApiConfig, provider_id: str) -> dict:
    async def query() -> dict:
        async with transaction(config) as conn:
            row = await conn.execute(select(llm.providers).where(llm.providers.c.id == provider_id))
            return dict(row.mappings().one())

    return asyncio.run(query())


def audits(config: ApiConfig, action: str) -> list[dict]:
    async def query() -> list[dict]:
        async with transaction(config) as conn:
            rows = await conn.execute(
                select(audit_log).where(audit_log.c.action == action).order_by(audit_log.c.id)
            )
            return [dict(r) for r in rows.mappings()]

    return asyncio.run(query())


@pytest.mark.ci11
@pytest.mark.parametrize(
    ("url", "network"),
    [
        ("http://127.0.0.1:8080/v1", "internal"),
        ("http://[::1]:8080/v1", "internal"),
        ("http://10.1.2.3/v1", "internal"),
        ("http://172.16.0.9/v1", "internal"),
        ("http://172.31.255.1/v1", "internal"),
        ("http://192.168.1.50:8888/v1", "internal"),
        ("http://[fd00::5]/v1", "internal"),
        ("http://169.254.1.1/v1", "internal"),
        ("http://[fe80::1]/v1", "internal"),
        ("http://172.32.0.1/v1", "public"),
        ("http://100.64.0.1/v1", "public"),
        ("http://8.8.8.8/v1", "public"),
        ("http://localhost:8080/v1", "public"),
        ("http://host.docker.internal:8080/v1", "public"),
        ("https://api.deepseek.com/v1", "public"),
    ],
)
def test_network_by_address(url: str, network: str) -> None:
    """C-LLM-13：只认地址，域名一律公网（含 localhost）。"""
    assert llm.classify(url) == network


@pytest.mark.parametrize(
    "url",
    [
        "http://192.168.1.50:8888/v1/chat/completions/",
        "http://192.168.1.50:8888/v1/models",
        " http://192.168.1.50:8888/v1/ ",
    ],
)
def test_pasted_endpoint_trimmed_to_base_url(url: str) -> None:
    """D-084：去掉末尾斜杠与误粘贴的接口路径。"""
    assert llm.normalize(url) == "http://192.168.1.50:8888/v1"


@pytest.mark.parametrize("url", ["192.168.1.50:8888/v1", "ftp://10.0.0.1/v1", "http:///v1"])
def test_non_http_url_rejected(url: str) -> None:
    with pytest.raises(HTTPException) as e:
        llm.normalize(url)
    assert e.value.status_code == 400


def test_api_key_sealed_with_random_nonce(key_file: Path) -> None:
    """C-ST-03：AES-256-GCM，密文不含明文，同一 Key 两次加密结果不同，可解密还原。"""
    a, b = llm.seal(key_file, KEY), llm.seal(key_file, KEY)
    assert KEY.encode() not in a and a != b
    assert llm.unseal(key_file, a) == llm.unseal(key_file, b) == KEY


def test_key_columns_keep_last4_and_clear_on_empty(key_file: Path) -> None:
    columns = llm.key_columns(key_file, KEY)
    assert columns["api_key_last4"] == "7f3a"
    assert llm.unseal(key_file, columns["api_key_enc"]) == KEY
    assert llm.key_columns(key_file, "") == {"api_key_enc": None, "api_key_last4": None}


def test_key_file_must_hold_32_bytes(tmp_path: Path) -> None:
    short = tmp_path / "short"
    short.write_text(base64.b64encode(os.urandom(16)).decode())
    with pytest.raises(ValueError, match="32"):
        llm.seal(short, KEY)


@pytest.mark.ci11
def test_public_provider_created_disabled(client: TestClient) -> None:
    """G-02、FR-604：公网新增即停用，内网新增即启用。"""
    assert create(client, CLOUD)["enabled"] is False
    assert create(client, LAN)["enabled"] is True


@pytest.mark.parametrize("role", ["viewer", "operator", "auditor"])
def test_non_admin_rejected(client: TestClient, password: str, role: str) -> None:
    body = {"username": role, "password": password}
    assert client.post("/api/auth/login", json=body, headers=headers()).status_code == 200
    assert client.get("/api/llm/providers").status_code == 403


def test_create_list_update_delete_audited(client: TestClient, db: tuple) -> None:
    created = create(client, LAN, api_key=KEY)
    assert created["api_key_last4"] == "7f3a"
    assert created["order"] == 0 and created["last_test"] is None
    assert [p["id"] for p in client.get("/api/llm/providers").json()["items"]] == [created["id"]]

    r = client.patch(
        f"/api/llm/providers/{created['id']}", json={"name": "改名"}, headers=headers()
    )
    assert r.status_code == 200 and r.json()["name"] == "改名"
    assert (
        client.delete(f"/api/llm/providers/{created['id']}", headers=headers()).status_code == 204
    )
    assert client.get("/api/llm/providers").json()["items"] == []
    assert (
        client.delete(f"/api/llm/providers/{created['id']}", headers=headers()).status_code == 404
    )

    actions = ["llm.provider_created", "llm.provider_updated", "llm.provider_deleted"]
    entries = [e for a in actions for e in audits(db[1], a) if e["target"] == created["id"]]
    assert [e["action"] for e in entries] == actions
    assert entries[1]["before"]["name"] == "家用 5070" and entries[1]["after"]["name"] == "改名"
    assert all(KEY not in str(e) for e in entries)


def test_api_key_encrypted_and_write_only(client: TestClient, db: tuple, key_file: Path) -> None:
    """C-ST-03、C-LLM-15：库中为密文，可解密还原；响应只含末 4 位；空串清除。"""
    created = create(client, LAN, api_key=KEY)
    row = stored(db[1], created["id"])
    assert KEY.encode() not in row["api_key_enc"]
    assert llm.unseal(key_file, row["api_key_enc"]) == KEY
    assert KEY not in client.get("/api/llm/providers").text

    r = client.patch(f"/api/llm/providers/{created['id']}", json={"api_key": ""}, headers=headers())
    assert r.json()["api_key_last4"] is None
    assert stored(db[1], created["id"])["api_key_enc"] is None


def test_network_override_and_recompute(client: TestClient) -> None:
    created = create(client, LAN, network="public")
    assert (created["network"], created["network_overridden"]) == ("public", True)
    assert created["enabled"] is False

    r = client.patch(
        f"/api/llm/providers/{created['id']}",
        json={"base_url": "http://10.0.0.8/v1"},
        headers=headers(),
    )
    assert (r.json()["network"], r.json()["network_overridden"]) == ("internal", False)


def test_internal_to_public_disables_unless_confirmed(client: TestClient) -> None:
    """G-02：改为公网地址即停用；前端确认后同一请求带 enabled=true 才保持启用。"""
    pid = create(client, LAN)["id"]
    r = client.patch(f"/api/llm/providers/{pid}", json=CLOUD, headers=headers())
    assert (r.json()["network"], r.json()["enabled"]) == ("public", False)

    other = create(client, LAN)["id"]
    r = client.patch(
        f"/api/llm/providers/{other}", json=CLOUD | {"enabled": True}, headers=headers()
    )
    assert r.json()["enabled"] is True
