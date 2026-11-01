"""AI 安全值班员调查循环（TK-116、FR-1101～FR-1106、SC-08、G-13）：以假网关回放每轮输出，断言推送、落库、
越权工具、轮数与时限、降级与触发条件。"""

import asyncio
import base64
import json
import os
import time
import uuid
from collections.abc import Callable, Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import httpx2
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, insert, select
from test_relay import next_frame
from test_reports import KEY, add_provider, attempt, login

from api_server import investigator, llm, relay
from api_server.app import create_app
from api_server.audit import audit_log
from api_server.config import ApiConfig
from api_server.db import transaction
from api_server.investigator import investigation_table
from py_common.bus import Bus
from py_contracts.api import Investigation
from py_contracts.events.hyd_correlator_incident_v1_schema import CorrelatorIncidentV1
from py_contracts.events.hyd_security_alert_v1_schema import SecurityAlertV1

ATTACKER = "172.30.0.100"
VERDICT = {"is_attack": True, "confidence": 0.9, "techniques": ["T1110"],
           "narrative": "172.30.0.100 对 cam-02 爆破", "recommendation": "封禁攻击源"}  # fmt: skip


def incident(iid: str, severity: str = "critical", age: timedelta = timedelta()) -> Any:
    now = datetime.now(UTC)
    return CorrelatorIncidentV1.model_validate({
        "schema_version": "1.2.0", "event_id": uuid.uuid4(), "ts": now, "id": iid,
        "rule_id": "HYD-X-0001", "rule_version": "1.0.0", "mode": "enforce",
        "title": "摄像头疑似被入侵且画面遭篡改", "severity": severity, "device_ids": ["cam-02"],
        "source_ip": ATTACKER, "techniques": ["T1110"], "tactics": ["Credential Access"],
        "evidence_refs": ["eve:1"], "hit_path": [], "requires_confirmation": True,
        "status": "open", "created_at": (now - age).isoformat(),
    })  # fmt: skip


def tool(name: str, args: dict[str, Any], reason: str = "查证") -> dict[str, Any]:
    return {"action": "tool", "reason": reason, "tool": name, "args": args, "verdict": None}


def verdict() -> dict[str, Any]:
    return {"action": "verdict", "reason": "证据充分", "tool": None, "args": None,
            "verdict": VERDICT}  # fmt: skip


def app_client(db: tuple[ApiConfig, ApiConfig], tmp_path: Path) -> TestClient:
    async def reset() -> None:
        async with transaction(db[1]) as conn:
            await conn.execute(delete(llm.providers))

    async def clear() -> None:  # 调查记录只能由属主删除
        async with transaction(db[0]) as conn:
            await conn.execute(delete(investigation_table))

    asyncio.run(reset())
    asyncio.run(clear())
    key_file = tmp_path / "llm_key_secret"
    key_file.write_text(base64.b64encode(os.urandom(32)).decode())
    config = db[1].model_copy(update={"llm_key_file": key_file})
    return TestClient(create_app(config), base_url="https://testserver")


@pytest.fixture
def client(
    db: tuple[ApiConfig, ApiConfig], password: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> Iterator[TestClient]:
    """不重放 JetStream：其他服务的用例发布的关联事件会进入调查队列、消耗假网关的回放。"""

    async def idle(*_: Any) -> None:
        await asyncio.Event().wait()

    monkeypatch.setattr(relay, "follow", idle)
    with app_client(db, tmp_path) as c:
        c.app.state.history.add_alert(
            SecurityAlertV1(
                schema_version="1.1.0",
                event_id=uuid.uuid4(),
                ts=datetime.now(UTC),
                rule_id="HYD-NET-0001",
                rule_version="3",
                mode="enforce",
                category="auth_bruteforce",
                severity="high",
                src_ip=ATTACKER,
                dst_ip="172.30.0.12",
                device_id="cam-02",
                technique="T1110",
                evidence_ref="eve:1",
                source="rule",
                confidence=1.0,
                summary="RTSP 认证爆破",
            )  # fmt: skip
        )
        yield c


def turns(client: TestClient, pid: str, outputs: list[dict[str, Any]], unverified=()) -> list:
    """假网关依次返回每轮输出，返回其收到的请求体。"""
    seen: list = []
    replies = iter(outputs)

    def handler(request: httpx2.Request) -> httpx2.Response:
        seen.append(json.loads(request.content))
        out = next(replies)
        body = {"output": out, "provider_id": pid, "attempts": [attempt(pid, "ok", tokens=20)],
                "unverified": list(unverified) if out["action"] == "verdict" else []}  # fmt: skip
        return httpx2.Response(200, json=body)

    state = client.app.state
    state.llm_gateway = httpx2.AsyncClient(
        base_url=state.config.llm_gateway_url, transport=httpx2.MockTransport(handler)
    )
    return seen


def submit(client: TestClient, event: CorrelatorIncidentV1) -> None:
    client.portal.call(client.app.state.investigator.submit, event)


def finished(client: TestClient, iid: str, timeout_s: float = 5) -> Investigation:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        r = client.get(f"/api/incidents/{iid}/investigation")
        if r.status_code == 200 and r.json()["finished_at"] is not None:
            return Investigation.model_validate(r.json())
        time.sleep(0.05)
    raise AssertionError(f"{iid} 未在 {timeout_s} 秒内结束调查")


def test_streams_steps_then_verdict(
    client: TestClient, password: str, ws_connect: Callable, db: tuple[ApiConfig, ApiConfig]
) -> None:
    pid = add_provider(client, password)
    outputs = [tool("list_alerts", {"ip": ATTACKER}, "先查攻击源"),
               tool("get_device", {"device_id": "cam-02"}), verdict()]  # fmt: skip
    seen = turns(client, pid, outputs, unverified=["10.9.9.9"])
    with ws_connect() as ws:
        submit(client, incident("inc-ok"))
        frames = []
        for _ in range(20):  # 其他频道的帧与超时哨兵跳过
            frame = next_frame(client, ws)
            if frame.channel == "ai":
                frames.append(frame.data)
            if len(frames) == 3:
                break
    assert [(f["seq"], f["kind"]) for f in frames] == [(0, "step"), (1, "step"), (2, "verdict")]
    assert frames[0]["step"] == {
        "tool": "list_alerts", "args_summary": "ip=172.30.0.100, minutes=10",
        "result_summary": "近 10 分钟 1 条告警，最近：RTSP 认证爆破（172.30.0.100 → 172.30.0.12）",
        "reason": "先查攻击源",
    }  # fmt: skip
    assert frames[2]["verdict"] == VERDICT | {"unverified": ["10.9.9.9"]}
    assert frames[2]["provider"] == {"name": "本地 llama.cpp", "location": "internal"}

    record = finished(client, "inc-ok")
    assert [s.model_dump() for s in record.steps] == [frames[0]["step"], frames[1]["step"]]
    assert record.verdict is not None and record.verdict.unverified == ["10.9.9.9"]
    assert record.error is None and record.provider is not None

    first, second, _ = seen
    assert first["task"] == "incident_investigation" and first["providers"][0]["api_key"] == KEY
    assert [b["data"]["rounds_left"] for b in seen] == [8, 7, 6]
    assert 0 < second["deadline_s"] < first["deadline_s"] <= investigator.DEADLINE_S
    [step] = second["data"]["steps"]
    assert step["args"] == {"ip": ATTACKER} and step["result"]["total"] == 1
    # 回溯依据只含事件与工具结果，不含模型给出的参数（FR-1103）
    assert second["evidence"] == {"incident": first["data"]["incident"],
                                  "results": [step["result"]]}  # fmt: skip

    async def audits() -> list[tuple[str, dict]]:
        async with transaction(db[1]) as conn:
            rows = await conn.execute(
                select(audit_log.c.actor, audit_log.c.after).where(
                    audit_log.c.action == "llm.invoked", audit_log.c.target == "inc-ok"
                )
            )
            return [(r.actor, r.after) for r in rows]

    rows = asyncio.run(audits())
    assert [(a, after["round"]) for a, after in rows] == [("ai-investigator", n) for n in (1, 2, 3)]
    [provider] = client.get("/api/llm/providers").json()["items"]
    assert provider["usage_today"] == {"calls": 3, "tokens": 60}


def test_rejected_and_repeated_tools_are_not_executed(client: TestClient, password: str) -> None:
    pid = add_provider(client, password)
    calls: list[str] = []
    real = client.app.state.tools.run

    async def counted(name: str, args: dict[str, Any]) -> Any:
        calls.append(name)
        return await real(name, args)

    client.app.state.tools.run = counted
    outputs = [tool("block_ip", {"ip": ATTACKER}), tool("list_alerts", {"ip": ATTACKER}),
               tool("list_alerts", {"ip": ATTACKER}), verdict()]  # fmt: skip
    seen = turns(client, pid, outputs)
    submit(client, incident("inc-tools"))
    record = finished(client, "inc-tools")
    assert [s.result_summary.split("：")[0] for s in record.steps] == [
        "已拒绝", "近 10 分钟 1 条告警，最近", "重复查询，已提示换个查询或给出判定"
    ]  # fmt: skip
    assert calls == ["block_ip", "list_alerts"]  # 重复的一次不执行；未知工具由工具层拒绝
    assert seen[3]["data"]["steps"][2]["result"] == {
        "error": "与第 2 步相同，请换一个查询或给出判定"
    }
    assert record.verdict is not None


def test_no_verdict_within_round_limit(client: TestClient, password: str) -> None:
    pid = add_provider(client, password)
    outputs = [tool("list_alerts", {"ip": ATTACKER, "minutes": m}) for m in range(1, 9)]
    turns(client, pid, outputs)
    submit(client, incident("inc-rounds"))
    record = finished(client, "inc-rounds")
    assert len(record.steps) == 8 and record.verdict is None
    assert record.error == "8 轮内未给出判定"


def test_deadline(client: TestClient, password: str, monkeypatch: pytest.MonkeyPatch) -> None:
    pid = add_provider(client, password)
    monkeypatch.setattr(investigator, "DEADLINE_S", 0.2)
    seen: list = []

    async def slow(request: httpx2.Request) -> httpx2.Response:
        seen.append(json.loads(request.content))
        await asyncio.sleep(0.3)
        body = {"output": tool("list_alerts", {"ip": ATTACKER}), "provider_id": pid,
                "attempts": [attempt(pid, "ok")], "unverified": []}  # fmt: skip
        return httpx2.Response(200, json=body)

    state = client.app.state
    state.llm_gateway = httpx2.AsyncClient(
        base_url=state.config.llm_gateway_url, transport=httpx2.MockTransport(slow)
    )
    submit(client, incident("inc-slow"))
    record = finished(client, "inc-slow")
    assert record.error == "未能在 0.2 秒内给出判定" and len(record.steps) == 1
    assert len(seen) == 1 and seen[0]["deadline_s"] <= 0.2


def test_unavailable_reasons(client: TestClient, password: str) -> None:
    """FR-1105：无供应商时不调网关；网关不可达时同样推送失败原因。"""
    submit(client, incident("inc-none"))
    login(client, "viewer", password)
    record = finished(client, "inc-none")
    assert (record.error, record.provider, record.steps) == ("未启用任何模型供应商", None, [])

    add_provider(client, password)

    def down(request: httpx2.Request) -> httpx2.Response:
        raise httpx2.ConnectError("refused", request=request)

    state = client.app.state
    state.llm_gateway = httpx2.AsyncClient(
        base_url=state.config.llm_gateway_url, transport=httpx2.MockTransport(down)
    )
    submit(client, incident("inc-down"))
    assert finished(client, "inc-down").error == "模型网关暂不可达"


def test_submit_conditions(
    client: TestClient, password: str, db: tuple[ApiConfig, ApiConfig]
) -> None:
    """只调查 high 及以上、10 分钟内、未调查过的关联事件；后续状态更新不重复调查。"""
    pid = add_provider(client, password)
    seen = turns(client, pid, [verdict()])

    async def recorded() -> None:  # 重启前已调查过
        async with transaction(db[1]) as conn:
            await conn.execute(
                insert(investigation_table).values(
                    incident_id="inc-done",
                    steps=[],
                    started_at=datetime.now(UTC),
                    finished_at=datetime.now(UTC),
                )  # fmt: skip
            )

    asyncio.run(recorded())
    for event in (incident("inc-medium", "medium"), incident("inc-old", age=timedelta(minutes=11)),
                  incident("inc-done"), incident("inc-high", "high"),
                  incident("inc-high", "high")):  # fmt: skip
        submit(client, event)
    login(client, "viewer", password)
    assert finished(client, "inc-high").verdict is not None
    assert len(seen) == 1
    for iid in ("inc-medium", "inc-old"):
        assert client.get(f"/api/incidents/{iid}/investigation").status_code == 404


def test_unfinished_marked_interrupted_on_start(
    db: tuple[ApiConfig, ApiConfig], password: str, tmp_path: Path
) -> None:
    async def leftover() -> None:
        async with transaction(db[1]) as conn:
            await conn.execute(
                insert(investigation_table).values(
                    incident_id="inc-left", steps=[], started_at=datetime.now(UTC)
                )
            )

    asyncio.run(leftover())
    with TestClient(create_app(db[1]), base_url="https://testserver") as c:
        login(c, "viewer", password)
        assert finished(c, "inc-left").error == "服务重启，调查中断"


def test_incident_from_bus_is_investigated(
    db: tuple[ApiConfig, ApiConfig], password: str, tmp_path: Path, nats_url: str
) -> None:
    """关联事件经 JetStream 到达 relay.follow 后提交调查（无供应商时以失败结束）。"""

    async def publish() -> None:
        bus = await Bus.connect(nats_url, name="test", timeout_s=2)
        try:
            await bus.ensure_stream("HYD_INCIDENT", ["hyd.correlator.incident.v1"], 3600)
            # 流为各服务用例共用：规则 ID 不与真实规则相同，免得 correlator 重启去重时把它当作已生成
            event = incident("inc-bus").model_copy(update={"rule_id": "HYD-TEST-0116"})
            await bus.js_publish("hyd.correlator.incident.v1", event)
        finally:
            await bus.close()

    with app_client(db, tmp_path) as c:
        asyncio.run(publish())
        login(c, "viewer", password)
        assert finished(c, "inc-bus").error == "未启用任何模型供应商"


def test_requires_login(client: TestClient) -> None:
    assert client.get("/api/incidents/inc-x/investigation").status_code == 401


def test_worker_survives_database_down_at_start() -> None:
    """启动时数据库不可达：标记中断失败只记日志，后台任务继续等待调查（CI 中曾因此整体退出）。"""

    class Down:
        def begin(self) -> None:
            raise OSError("数据库不可达")

    async def main() -> bool:
        task = asyncio.create_task(investigator.Investigator(SimpleNamespace(engine=Down())).run())
        await asyncio.sleep(0.05)
        alive = not task.done()
        task.cancel()
        return alive

    assert asyncio.run(main())


def test_unexpected_error_ends_investigation_as_failed(client: TestClient, password: str) -> None:
    """调查中途意外出错：补发失败帧并结束记录，面板不会一直显示进行中（FR-1105）。"""
    pid = add_provider(client, password)
    turns(client, pid, [tool("list_alerts", {"ip": ATTACKER})])

    async def broken(*_: Any) -> Any:
        raise RuntimeError("工具内部缺陷")

    client.app.state.tools.run = broken
    submit(client, incident("inc-broken"))
    record = finished(client, "inc-broken")
    assert record.error == "调查出错，详见服务日志" and record.verdict is None
