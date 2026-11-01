"""溯源报告（FR-501～FR-504、TK-070）：生成模板报告、事实区内容、查看、复核与审计。"""

import asyncio
import base64
import json
import os
import time
import uuid
from collections.abc import Callable, Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx2
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, select, update

from api_server import llm
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
MARKUP = "<script>alert(1)</script>"  # 事件内容来自外部输入，导出时须转义


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
        confidence=1.0, detail=MARKUP,
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
def client(db: tuple[ApiConfig, ApiConfig], password: str, tmp_path: Path) -> Iterator[TestClient]:
    async def reset() -> None:  # 其他用例留下的供应商会让报告改走模型
        async with transaction(db[1]) as conn:
            await conn.execute(delete(llm.providers))

    asyncio.run(reset())
    key_file = tmp_path / "llm_key_secret"
    key_file.write_text(base64.b64encode(os.urandom(32)).decode())
    config = db[1].model_copy(update={"llm_key_file": key_file})
    with TestClient(create_app(config), base_url="https://testserver") as c:
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


def export(client: TestClient, report_id: str, fmt: str) -> httpx2.Response:
    return client.get(f"/api/reports/{report_id}/export", params={"format": fmt})


def test_export_html_unreviewed(client: TestClient, password: str) -> None:
    """FR-504、V-AI1、V-AI5：网页带水印，事实区与 AI 区分开，模板模式注明原因；事件内容转义。"""
    login(client, "operator", password)
    report = generate(client)
    login(client, "viewer", password)

    r = export(client, report.id, "html")

    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/html")
    assert r.headers["content-disposition"] == f'inline; filename="report-{report.id}.html"'
    assert r.headers["content-security-policy"] == "default-src 'none'; style-src 'unsafe-inline'"
    html = r.text
    assert 'class="watermark"' in html and "未复核草稿" in html
    assert html.index("事实区") < html.index("AI 分析区")
    assert "模型不可用，以下为规则模板生成（原因：未启用任何模型供应商）" in html
    assert "证据缺失" in html and "172.30.0.100" in html
    assert MARKUP not in html and "&lt;script&gt;" in html


def test_export_markdown(client: TestClient, password: str) -> None:
    """D-078：Markdown 以附件下载，未复核时开头与结尾标注；复核后两种格式都不带水印。"""
    login(client, "operator", password)
    report = generate(client)

    r = export(client, report.id, "md")

    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/markdown")
    assert r.headers["content-disposition"] == f'attachment; filename="report-{report.id}.md"'
    lines = r.text.strip().splitlines()
    assert "未复核草稿" in lines[0] and "未复核草稿" in lines[-1]
    assert "## 事实区" in r.text and "## AI 分析区" in r.text
    assert MARKUP not in r.text and r"\<script\>" in r.text

    client.post(f"/api/reports/{report.id}/review", headers=rid())
    assert "未复核草稿" not in export(client, report.id, "md").text
    html = export(client, report.id, "html").text
    assert 'class="watermark"' not in html and "已复核" in html


def test_export_rejects_unknown(client: TestClient, password: str) -> None:
    login(client, "viewer", password)
    assert export(client, "missing", "html").status_code == 404
    assert client.get("/api/reports/missing/export", params={"format": "pdf"}).status_code == 400


# 模型生成 AI 区（TK-062、FR-502、FR-503、G-13、D-084）

KEY = "sk-not-a-real-key-7f3a"
AI = {
    "summary": "172.30.0.100 对 cam-02 爆破后画面冻结，已封禁",
    "attack_chain": [
        {"tactic": "Credential Access", "technique_id": "T1110", "description": "RTSP 认证爆破",
         "evidence_refs": ["eve:1"]},
    ],
    "impact": [{"device_id": "cam-02", "description": "画面冻结"}],
    "recommendations": [{"action": "修改默认口令", "rationale": "爆破针对弱口令"}],
    "confidence": "high",
}  # fmt: skip


def attempt(pid: str, outcome: str, reason: str | None = None, tokens: int = 0) -> dict:
    return {
        "provider_id": pid, "outcome": outcome, "reason": reason, "latency_ms": 10,
        "tokens": tokens, "redacted": False,
    }  # fmt: skip


def add_provider(client: TestClient, password: str, name: str = "家用 5070") -> str:
    login(client, "admin", password)
    body = {"name": name, "preset": "llama_cpp", "base_url": "http://192.168.1.50:8888/v1",
            "model": "qwen3-8b", "api_key": KEY}  # fmt: skip
    r = client.post("/api/llm/providers", json=body, headers=rid())
    assert r.status_code == 201
    return r.json()["id"]


def gateway(client: TestClient, handler: Callable[[httpx2.Request], httpx2.Response]) -> list:
    """以假网关替换真实连接，返回其收到的请求体。"""
    seen: list = []

    def record(request: httpx2.Request) -> httpx2.Response:
        seen.append(json.loads(request.content))
        return handler(request)

    state = client.app.state
    state.llm_gateway = httpx2.AsyncClient(
        base_url=state.config.llm_gateway_url, transport=httpx2.MockTransport(record)
    )
    return seen


def actions(config: ApiConfig, request_id: str) -> dict[str, dict]:
    async def query() -> dict[str, dict]:
        async with transaction(config) as conn:
            rows = await conn.execute(
                select(audit_log.c.action, audit_log.c.after).where(
                    audit_log.c.request_id == request_id
                )
            )
            return {r.action: r.after for r in rows}

    return asyncio.run(query())


def generate_with(client: TestClient, headers: dict[str, str]) -> Report:
    r = client.post("/api/incidents/inc-rep/reports", headers=headers)
    assert r.status_code == 201
    return Report.model_validate(r.json())


def test_llm_report(client: TestClient, password: str, db: tuple[ApiConfig, ApiConfig]) -> None:
    pid = add_provider(client, password)

    async def stale_usage() -> None:  # 昨日的用量跨日后从零累计
        async with transaction(db[1]) as conn:
            yesterday = datetime.now(UTC).date() - timedelta(days=1)
            await conn.execute(
                update(llm.providers).values(usage_day=yesterday, usage_calls=5, usage_tokens=900)
            )

    asyncio.run(stale_usage())
    reply = {"output": AI, "unverified": ["10.9.9.9"], "provider_id": pid,
             "attempts": [attempt(pid, "failed", "输出两次不符合格式", 40),
                          attempt(pid, "ok", None, 30)]}  # fmt: skip
    seen = gateway(client, lambda _: httpx2.Response(200, json=reply))
    headers = rid()
    r = client.post("/api/incidents/inc-rep/reports", headers=headers)
    assert r.status_code == 201
    report = Report.model_validate(r.json())

    assert (report.source, report.provider_id, report.degraded_reason) == ("llm", pid, None)
    assert report.ai is not None and report.ai.content.model_dump(mode="json") == AI
    assert (report.ai.unverified, report.ai.provider_name, report.ai.model) == (
        ["10.9.9.9"], "家用 5070", "qwen3-8b"
    )  # fmt: skip
    assert client.get(f"/api/reports/{report.id}").json()["ai"] == r.json()["ai"]
    [body] = seen
    assert body["task"] == "incident_report"
    assert body["data"] == report.facts.model_dump(mode="json")
    assert [(p["id"], p["api_key"], p["network"]) for p in body["providers"]] == [
        (pid, KEY, "internal")
    ]  # fmt: skip

    audit = actions(db[1], headers["X-Request-ID"])
    assert set(audit) == {"report.created", "llm.invoked"}
    assert audit["llm.invoked"]["report_id"] == report.id
    assert [a["outcome"] for a in audit["llm.invoked"]["attempts"]] == ["failed", "ok"]
    assert KEY not in json.dumps(audit, ensure_ascii=False)
    [provider] = client.get("/api/llm/providers").json()["items"]
    assert provider["usage_today"] == {"calls": 2, "tokens": 70}


def test_all_providers_failed_falls_back_within_3s(
    client: TestClient, password: str, db: tuple[ApiConfig, ApiConfig]
) -> None:
    """FR-502：全部失败时 3 s 内落模板，原因列出每家；失败的请求同样计入用量。"""
    a, b = add_provider(client, password), add_provider(client, password, "DeepSeek 备用")
    reply = {"output": None, "unverified": [], "provider_id": None,
             "attempts": [attempt(a, "failed", "API Key 无效或无权限（HTTP 401）"),
                          attempt(b, "skipped", "连续失败 4 次，暂停调用至 08:01:00 UTC")]}  # fmt: skip
    gateway(client, lambda _: httpx2.Response(200, json=reply))
    headers = rid()
    started = time.monotonic()
    report = generate_with(client, headers)
    assert time.monotonic() - started < 3
    assert (report.source, report.ai, report.provider_id) == ("template", None, None)
    assert report.degraded_reason == (
        "全部模型供应商不可用：家用 5070（API Key 无效或无权限（HTTP 401））；"
        "DeepSeek 备用（连续失败 4 次，暂停调用至 08:01:00 UTC）"
    )
    assert set(actions(db[1], headers["X-Request-ID"])) == {"report.created", "llm.invoked"}
    items = client.get("/api/llm/providers").json()["items"]
    assert {p["id"]: p["usage_today"]["calls"] for p in items} == {a: 1, b: 0}  # 跳过的未发请求


def test_gateway_unreachable_falls_back_within_3s(client: TestClient, password: str) -> None:
    add_provider(client, password)

    def down(request: httpx2.Request) -> httpx2.Response:
        raise httpx2.ConnectError("refused", request=request)

    gateway(client, down)
    started = time.monotonic()
    report = generate_with(client, rid())
    assert time.monotonic() - started < 3
    assert (report.source, report.degraded_reason) == ("template", "模型网关暂不可达")


def test_undecryptable_key_is_not_forwarded(
    client: TestClient, password: str, tmp_path: Path
) -> None:
    add_provider(client, password)
    other = tmp_path / "replaced_secret"
    other.write_text(base64.b64encode(os.urandom(32)).decode())
    state = client.app.state
    state.config = state.config.model_copy(update={"llm_key_file": other})
    seen = gateway(client, lambda _: httpx2.Response(500))
    report = generate_with(client, rid())
    assert seen == []
    assert report.degraded_reason == "全部模型供应商不可用：家用 5070（已存的 Key 无法解密）"
