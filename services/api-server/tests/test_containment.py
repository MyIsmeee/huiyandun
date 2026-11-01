"""手动回滚（FR-405、TK-052）与确认处置（FR-407、TK-117）接口：角色、前置状态、发布请求与审计。"""

import asyncio
import uuid
from collections.abc import Callable, Iterator
from datetime import UTC, datetime

import nats
import nats.js.errors
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.exc import OperationalError

from api_server import containment
from api_server.app import create_app
from api_server.audit import audit_log
from api_server.config import ApiConfig
from api_server.db import transaction
from py_common.bus import Bus
from py_contracts.events.hyd_correlator_confirmation_v1_schema import CorrelatorConfirmationV1
from py_contracts.events.hyd_correlator_incident_v1_schema import CorrelatorIncidentV1
from py_contracts.events.hyd_playbook_execution_v1_schema import PlaybookExecutionV1
from py_contracts.events.hyd_playbook_rollback_v1_schema import PlaybookRollbackV1

SUBJECT = "hyd.playbook.rollback.v1"
CONFIRM_SUBJECT = "hyd.correlator.confirmation.v1"
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


def incident(incident_id: str, requires_confirmation: bool) -> CorrelatorIncidentV1:
    now = datetime.now(UTC)
    return CorrelatorIncidentV1.model_validate(
        {
            "schema_version": "1.2.0", "event_id": str(uuid.uuid4()), "ts": now.isoformat(),
            "id": incident_id, "rule_id": "HYD-X-0001", "rule_version": "1.0.0", "mode": "enforce",
            "title": "摄像头疑似被入侵且画面遭篡改", "severity": "critical", "device_ids": ["cam-02"],
            "source_ip": "172.30.0.100", "techniques": ["T1110"], "tactics": ["Credential Access"],
            "evidence_refs": [], "hit_path": [], "requires_confirmation": requires_confirmation,
            "status": "open", "created_at": now.isoformat(),
        }
    )  # fmt: skip


def command_stream(nats_url: str, present: bool) -> None:
    async def main() -> None:
        bus = await Bus.connect(nats_url, name="test", timeout_s=2)
        raw = await nats.connect(nats_url)
        try:
            if present:
                await bus.ensure_stream("HYD_COMMAND", [CONFIRM_SUBJECT, SUBJECT], 3600)
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
        c.app.state.history.add_incident(incident("inc-model", requires_confirmation=True))
        c.app.state.history.add_incident(incident("inc-rule", requires_confirmation=False))
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


def published[T](nats_url: str, post: Callable[[], None], subject: str, model: type[T]) -> list[T]:
    """调用 post 期间在 subject 上收到的请求。"""
    received: list[T] = []

    async def listen() -> None:
        bus = await Bus.connect(nats_url, name="listen", timeout_s=2)

        async def on_request(event: T) -> None:
            received.append(event)

        await bus.subscribe(subject, model, on_request)
        await asyncio.to_thread(post)
        await asyncio.sleep(0.3)
        await bus.close()

    asyncio.run(listen())
    return received


def audited(
    config: ApiConfig, request_id: str, action: str = "playbook.rollback_requested"
) -> list[tuple[str, str, str]]:
    async def query() -> list[tuple[str, str, str]]:
        async with transaction(config) as conn:
            rows = await conn.execute(
                select(audit_log.c.actor, audit_log.c.action, audit_log.c.target).where(
                    audit_log.c.request_id == request_id,
                    audit_log.c.action == action,
                )
            )
            return [tuple(r) for r in rows]

    return asyncio.run(query())


def test_rollback_request_published_and_audited(
    client: TestClient, password: str, db: tuple[ApiConfig, ApiConfig], nats_url: str
) -> None:
    command_stream(nats_url, present=True)
    login(client, "operator", password)
    responses: list[int] = []

    def post() -> None:
        responses.append(client.post("/api/executions/exe-api/rollback", headers=RID).status_code)

    received = published(nats_url, post, SUBJECT, PlaybookRollbackV1)
    assert responses == [200]
    assert [(r.execution_id, r.actor, r.request_id) for r in received] == [
        ("exe-api", "operator", "req-rollback")
    ]
    assert audited(db[1], "req-rollback") == [
        ("operator", "playbook.rollback_requested", "172.30.0.100")
    ]


def test_audit_failure_not_published(
    client: TestClient, password: str, nats_url: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """G-13：写审计失败（如数据库断开）时不发布回滚请求，避免没有审计的解封。"""
    command_stream(nats_url, present=True)
    login(client, "operator", password)

    async def broken(*args: object, **kwargs: object) -> None:
        raise OperationalError("insert", {}, Exception("connection lost"))

    monkeypatch.setattr(containment, "record", broken)

    responses: list[int] = []

    def post() -> None:
        responses.append(client.post("/api/executions/exe-api/rollback", headers=RID).status_code)

    assert published(nats_url, post, SUBJECT, PlaybookRollbackV1) == []
    assert responses == [500]


def test_executor_unreachable_reported(
    client: TestClient, password: str, db: tuple[ApiConfig, ApiConfig], nats_url: str
) -> None:
    """命令流尚未由 playbook-executor 创建：提示稍后重试，审计随事务回滚。"""
    command_stream(nats_url, present=False)
    login(client, "operator", password)
    headers = {"X-Request-ID": "req-unreachable"}
    assert client.post("/api/executions/exe-api/rollback", headers=headers).status_code == 503
    assert audited(db[1], "req-unreachable") == []


def test_viewer_cannot_confirm(client: TestClient, password: str) -> None:
    """C-FE-07 的服务端保障：viewer 不能确认处置（FR-407）。"""
    login(client, "viewer", password)
    r = client.post("/api/incidents/inc-model/confirm-containment", headers=RID)
    assert r.status_code == 403


@pytest.mark.parametrize(("incident_id", "status"), [("missing", 404), ("inc-rule", 400)])
def test_unknown_or_unconfirmable_incident_rejected(
    client: TestClient, password: str, incident_id: str, status: int
) -> None:
    """纯规则命中的事件无需确认，确认请求被拒绝，不发布。"""
    login(client, "operator", password)
    r = client.post(f"/api/incidents/{incident_id}/confirm-containment", headers=RID)
    assert r.status_code == status


def test_confirmation_published_and_audited(
    client: TestClient, password: str, db: tuple[ApiConfig, ApiConfig], nats_url: str
) -> None:
    """FR-407：发布确认事件（只含事件 ID 与操作者，处置参数由执行器取自关联事件，G-03），并写审计。"""
    command_stream(nats_url, present=True)
    login(client, "operator", password)
    headers = {"X-Request-ID": "req-confirm"}
    responses: list[int] = []

    def post() -> None:
        r = client.post("/api/incidents/inc-model/confirm-containment", headers=headers)
        responses.append(r.status_code)

    received = published(nats_url, post, CONFIRM_SUBJECT, CorrelatorConfirmationV1)
    assert responses == [202]
    assert [(r.incident_id, r.actor, r.request_id) for r in received] == [
        ("inc-model", "operator", "req-confirm")
    ]
    assert audited(db[1], "req-confirm", "incident.containment_confirmed") == [
        ("operator", "incident.containment_confirmed", "inc-model")
    ]


def test_confirm_audit_failure_not_published(
    client: TestClient, password: str, nats_url: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """G-13：写审计失败时不发布确认，避免没有审计的封禁。"""
    command_stream(nats_url, present=True)
    login(client, "operator", password)

    async def broken(*args: object, **kwargs: object) -> None:
        raise OperationalError("insert", {}, Exception("connection lost"))

    monkeypatch.setattr(containment, "record", broken)
    responses: list[int] = []

    def post() -> None:
        r = client.post("/api/incidents/inc-model/confirm-containment", headers=RID)
        responses.append(r.status_code)

    assert published(nats_url, post, CONFIRM_SUBJECT, CorrelatorConfirmationV1) == []
    assert responses == [500]


def test_confirm_executor_unreachable_reported(
    client: TestClient, password: str, db: tuple[ApiConfig, ApiConfig], nats_url: str
) -> None:
    """命令流尚未由 playbook-executor 创建：提示稍后重试，审计随事务回滚。"""
    command_stream(nats_url, present=False)
    login(client, "operator", password)
    headers = {"X-Request-ID": "req-confirm-unreachable"}
    r = client.post("/api/incidents/inc-model/confirm-containment", headers=headers)
    assert r.status_code == 503
    assert audited(db[1], "req-confirm-unreachable", "incident.containment_confirmed") == []
