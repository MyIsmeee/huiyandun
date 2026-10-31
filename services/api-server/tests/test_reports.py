"""溯源报告（FR-501～FR-504、TK-070）：生成模板报告、事实区内容、查看、复核与审计。"""

import asyncio
import time
import uuid
from collections.abc import Iterator
from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from api_server.app import create_app
from api_server.audit import audit_log
from api_server.config import ApiConfig
from api_server.db import transaction
from py_contracts.api import Report
from py_contracts.events.hyd_correlator_incident_v1_schema import CorrelatorIncidentV1
from py_contracts.events.hyd_playbook_execution_v1_schema import PlaybookExecutionV1
from py_contracts.events.hyd_security_alert_v1_schema import SecurityAlertV1
from py_contracts.events.hyd_vision_integrity_v1_schema import VisionIntegrityV1

ALERT_ID, FREEZE_ID, LOST_ID = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()


def common(event_id: uuid.UUID | None = None) -> dict[str, object]:
    return {
        "schema_version": "1.0.0",
        "event_id": event_id or uuid.uuid4(),
        "ts": datetime.now(UTC),
    }


def incident(status: str = "open") -> CorrelatorIncidentV1:
    return CorrelatorIncidentV1.model_validate(
        common() | {
            "schema_version": "1.2.0", "id": "inc-rep", "rule_id": "HYD-X-0001",
            "rule_version": "1.0.0", "mode": "enforce", "title": "摄像头疑似被入侵且画面遭篡改",
            "severity": "critical", "device_ids": ["cam-02"], "source_ip": "172.30.0.100",
            "techniques": ["T1110", "T0832"], "tactics": ["Credential Access", "Impact"],
            "evidence_refs": ["eve:1"], "hit_path": [str(ALERT_ID), str(FREEZE_ID), str(LOST_ID)],
            "requires_confirmation": False, "status": status,
            "created_at": datetime.now(UTC).isoformat(),
        }
    )  # fmt: skip


def alert() -> SecurityAlertV1:
    return SecurityAlertV1(
        **common(ALERT_ID), rule_id="HYD-NET-0001", rule_version="3", mode="enforce",
        category="auth_bruteforce", severity="high", src_ip="172.30.0.100", dst_ip="172.30.0.12",
        device_id="cam-02", technique="T1110", evidence_ref="eve:1", source="rule",
        confidence=1.0, summary="RTSP 认证爆破",
    )  # fmt: skip


def freeze() -> VisionIntegrityV1:
    return VisionIntegrityV1(
        **common(FREEZE_ID), camera_id="cam-02", type="freeze", duration_s=4.0, source="rule",
        confidence=1.0, detail=None,
    )  # fmt: skip


def execution() -> PlaybookExecutionV1:
    return PlaybookExecutionV1.model_validate(
        common() | {
            "schema_version": "1.1.0", "id": "exe-rep", "playbook_id": "isolate-attacker",
            "playbook_version": "1.0.0", "incident_id": "inc-rep", "device_ids": ["cam-02"],
            "target": "172.30.0.100", "state": "contained", "reason": None, "ttl_s": 150,
            "expires_at": datetime.now(UTC).isoformat(),
            "verify_result": {"passed": True, "reason": "已拦截 12 个数据包"},
        }
    )  # fmt: skip


@pytest.fixture
def client(db: tuple[ApiConfig, ApiConfig], password: str) -> Iterator[TestClient]:
    with TestClient(create_app(db[1]), base_url="https://testserver") as c:
        history = c.app.state.history
        history.add_incident(incident())
        history.add_incident(incident("contained"))  # 同一事件的后续状态
        history.add_alert(alert())
        history.add_integrity(freeze())
        history.add_execution(execution())
        yield c


def login(client: TestClient, role: str, password: str) -> None:
    body = {"username": role, "password": password}
    assert client.post("/api/auth/login", json=body, headers=rid()).status_code == 200


def rid() -> dict[str, str]:
    return {"X-Request-ID": f"req-{uuid.uuid4()}"}


def audited(config: ApiConfig, request_id: str) -> list[tuple[str, str, str]]:
    async def query() -> list[tuple[str, str, str]]:
        async with transaction(config) as conn:
            rows = await conn.execute(
                select(audit_log.c.actor, audit_log.c.action, audit_log.c.target).where(
                    audit_log.c.request_id == request_id
                )
            )
            return [tuple(r) for r in rows]

    return asyncio.run(query())


def generate(client: TestClient) -> Report:
    r = client.post("/api/incidents/inc-rep/reports", headers=rid())
    assert r.status_code == 201
    return Report.model_validate(r.json())


def test_viewer_cannot_generate(client: TestClient, password: str) -> None:
    login(client, "viewer", password)
    assert client.post("/api/incidents/inc-rep/reports", headers=rid()).status_code == 403


def test_unknown_incident_not_found(client: TestClient, password: str) -> None:
    login(client, "operator", password)
    assert client.post("/api/incidents/missing/reports", headers=rid()).status_code == 404


def test_template_report_within_3s(
    client: TestClient, password: str, db: tuple[ApiConfig, ApiConfig]
) -> None:
    """FR-502：没有可用供应商时 3 s 内产出模板报告并注明原因；事实区全部来自结构化事件（FR-501）。"""
    login(client, "operator", password)
    headers = rid()
    started = time.monotonic()
    r = client.post("/api/incidents/inc-rep/reports", headers=headers)
    assert time.monotonic() - started < 3
    assert r.status_code == 201
    report = Report.model_validate(r.json())

    assert (report.source, report.ai, report.provider_id) == ("template", None, None)
    assert report.degraded_reason == "未启用任何模型供应商"
    assert report.reviewed_by is None
    facts = report.facts
    assert facts.incident.status == "contained"  # 取最新状态
    assert [(d.id, str(d.ip)) for d in facts.devices] == [("cam-02", "172.30.0.12")]
    # 命中路径顺序；找不到的事件记为证据缺失
    assert [(e.event_id, e.kind) for e in facts.timeline] == [
        (ALERT_ID, "security_alert"),
        (FREEZE_ID, "integrity"),
        (LOST_ID, None),
    ]
    assert facts.timeline[2].event is None
    assert [(x.id, x.state) for x in facts.executions] == [("exe-rep", "contained")]
    assert audited(db[1], headers["X-Request-ID"]) == [("operator", "report.created", "inc-rep")]


def test_get_report(client: TestClient, password: str) -> None:
    login(client, "operator", password)
    report = generate(client)
    login(client, "viewer", password)

    r = client.get(f"/api/reports/{report.id}")

    assert r.status_code == 200
    assert Report.model_validate(r.json()) == report
    assert client.get("/api/reports/missing").status_code == 404


def test_review_recorded_and_audited(
    client: TestClient, password: str, db: tuple[ApiConfig, ApiConfig]
) -> None:
    """FR-504：复核记录当前账户与时间并写审计；已复核的不能再复核。"""
    login(client, "operator", password)
    report = generate(client)
    login(client, "viewer", password)
    assert client.post(f"/api/reports/{report.id}/review", headers=rid()).status_code == 403

    login(client, "admin", password)
    headers = rid()
    r = client.post(f"/api/reports/{report.id}/review", headers=headers)

    assert r.status_code == 200
    reviewed = Report.model_validate(r.json())
    assert reviewed.reviewed_by == "admin" and reviewed.reviewed_at is not None
    assert client.get(f"/api/reports/{report.id}").json()["reviewed_by"] == "admin"
    assert audited(db[1], headers["X-Request-ID"]) == [("admin", "report.reviewed", report.id)]
    assert client.post(f"/api/reports/{report.id}/review", headers=rid()).status_code == 409
    assert client.post("/api/reports/missing/review", headers=rid()).status_code == 404
