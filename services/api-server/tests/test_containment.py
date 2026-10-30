"""手动回滚接口（FR-405、TK-052）：角色、执行状态、发布回滚请求与审计。"""

import asyncio
import uuid
from collections.abc import Iterator
from datetime import UTC, datetime

import nats
import nats.js.errors
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from api_server.app import create_app
from api_server.audit import audit_log
from api_server.config import ApiConfig
from api_server.db import transaction
from py_common.bus import Bus
from py_contracts.events.hyd_playbook_execution_v1_schema import PlaybookExecutionV1
from py_contracts.events.hyd_playbook_rollback_v1_schema import PlaybookRollbackV1

SUBJECT = "hyd.playbook.rollback.v1"
RID = {"X-Request-ID": "req-rollback"}


def execution(state: str, execution_id: str = "exe-api") -> PlaybookExecutionV1:
    return PlaybookExecutionV1.model_validate(
        {
            "schema_version": "1.1.0", "event_id": str(uuid.uuid4()),
            "ts": datetime.now(UTC).isoformat(), "id": execution_id,
            "playbook_id": "isolate-attacker", "playbook_version": "1.0.0", "incident_id": "inc-1",
            "device_ids": ["cam-02"], "target": "172.30.0.100", "state": state, "reason": None,
            "ttl_s": 150, "expires_at": None, "verify_result": None,
        }
    )  # fmt: skip


def command_stream(nats_url: str, present: bool) -> None:
    async def main() -> None:
        bus = await Bus.connect(nats_url, name="test", timeout_s=2)
        raw = await nats.connect(nats_url)
        try:
            if present:
                await bus.ensure_stream("HYD_COMMAND", [SUBJECT], 3600)
            else:
                try:
                    await raw.jetstream().delete_stream("HYD_COMMAND")
                except nats.js.errors.NotFoundError:
                    pass
        finally:
            await raw.close()
            await bus.close()

    asyncio.run(main())


@pytest.fixture
def client(db: tuple[ApiConfig, ApiConfig], password: str) -> Iterator[TestClient]:
    with TestClient(create_app(db[1]), base_url="https://testserver") as c:
        c.app.state.history.add_execution(execution("contained"))
        c.app.state.history.add_execution(execution("rolled_back", "exe-done"))
        yield c


def login(client: TestClient, role: str, password: str) -> None:
    body = {"username": role, "password": password}
    assert client.post("/api/auth/login", json=body, headers=RID).status_code == 200


def test_viewer_cannot_roll_back(client: TestClient, password: str) -> None:
    """C-FE-07 的服务端保障：viewer 调用被拒绝。"""
    login(client, "viewer", password)
    assert client.post("/api/executions/exe-api/rollback", headers=RID).status_code == 403


@pytest.mark.parametrize(("execution_id", "status"), [("missing", 404), ("exe-done", 409)])
def test_unknown_or_finished_execution_rejected(
    client: TestClient, password: str, execution_id: str, status: int
) -> None:
    login(client, "operator", password)
    r = client.post(f"/api/executions/{execution_id}/rollback", headers=RID)
    assert r.status_code == status


def test_rollback_request_published_and_audited(
    client: TestClient, password: str, db: tuple[ApiConfig, ApiConfig], nats_url: str
) -> None:
    command_stream(nats_url, present=True)
    login(client, "operator", password)
    received: list[PlaybookRollbackV1] = []

    async def listen() -> None:
        bus = await Bus.connect(nats_url, name="listen", timeout_s=2)

        async def on_request(event: PlaybookRollbackV1) -> None:
            received.append(event)

        await bus.subscribe(SUBJECT, PlaybookRollbackV1, on_request)
        await asyncio.to_thread(lambda: responses.append(post()))
        await asyncio.sleep(0.3)
        await bus.close()

    def post() -> int:
        return client.post("/api/executions/exe-api/rollback", headers=RID).status_code

    responses: list[int] = []
    asyncio.run(listen())

    assert responses == [200]
    assert [(r.execution_id, r.actor, r.request_id) for r in received] == [
        ("exe-api", "operator", "req-rollback")
    ]

    async def audited() -> list[tuple[str, str, str]]:
        async with transaction(db[1]) as conn:
            rows = await conn.execute(
                select(audit_log.c.actor, audit_log.c.action, audit_log.c.target).where(
                    audit_log.c.request_id == "req-rollback",
                    audit_log.c.action == "playbook.rollback_requested",
                )
            )
            return [tuple(r) for r in rows]

    assert asyncio.run(audited()) == [("operator", "playbook.rollback_requested", "172.30.0.100")]


def test_executor_unreachable_reported(client: TestClient, password: str, nats_url: str) -> None:
    """命令流尚未由 playbook-executor 创建：提示稍后重试，不写审计。"""
    command_stream(nats_url, present=False)
    login(client, "operator", password)
    assert client.post("/api/executions/exe-api/rollback", headers=RID).status_code == 503
