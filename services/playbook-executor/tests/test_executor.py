"""处置编排（TK-050）：触发、白名单、模式、互斥、确认与过期、失败回滚、TTL、手动回滚、拦截证据、重启恢复。"""

import asyncio
import uuid
from collections.abc import Coroutine
from datetime import UTC, datetime, timedelta
from ipaddress import ip_network
from pathlib import Path
from typing import Any

import pytest

from playbook_executor import executor as executor_module
from playbook_executor.action import ActionContext, ActionError, Result
from playbook_executor.executor import Executor
from playbook_executor.playbooks import load_playbooks
from py_contracts.events.hyd_correlator_confirmation_v1_schema import CorrelatorConfirmationV1
from py_contracts.events.hyd_playbook_execution_v1_schema import PlaybookExecutionV1
from py_contracts.events.hyd_playbook_rollback_v1_schema import PlaybookRollbackV1
from py_contracts.events.incident_schema import Incident

ROOT = Path(__file__).resolve().parents[3]
PLAYBOOKS = load_playbooks(ROOT / "playbooks")
WHITELIST = [ip_network("172.30.0.0/28")]


@pytest.fixture(autouse=True)
def fast(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(executor_module, "EVIDENCE_INTERVAL_S", 0.02)
    monkeypatch.setattr(executor_module, "EVIDENCE_WINDOW_S", 0.1)


class FakeAction:
    def __init__(self, fail: str | None = None, packets: int | None = 60) -> None:
        self.fail = fail  # execute / verify：在该步失败
        self.packets = packets
        self.calls: list[str] = []

    async def precheck(self, ctx: ActionContext) -> Result:
        self.calls.append("precheck")
        return Result(True)

    async def execute(self, ctx: ActionContext) -> None:
        self.calls.append("execute")
        if self.fail == "execute":
            raise ActionError("privileged-helper 不可达")

    async def verify(self, ctx: ActionContext) -> Result:
        self.calls.append("verify")
        if self.fail == "verify":
            return Result(False, "封禁规则未在内核防火墙中生效")
        return Result(True, "封禁规则已在内核防火墙中生效")

    async def rollback(self, ctx: ActionContext) -> None:
        self.calls.append("rollback")

    async def intercepted(self, ctx: ActionContext) -> int | None:
        return self.packets


def incident(**changes: Any) -> Incident:
    return Incident.model_validate(
        {
            "id": str(uuid.uuid4()),
            "rule_id": "HYD-X-0001",
            "rule_version": "1.0.0",
            "mode": "enforce",
            "title": "摄像头疑似被入侵且画面遭篡改",
            "severity": "critical",
            "device_ids": ["cam-02"],
            "source_ip": "172.30.0.100",
            "techniques": ["T1110", "T0832"],
            "tactics": ["Credential Access", "Impact"],
            "evidence_refs": [],
            "hit_path": [],
            "requires_confirmation": False,
            "status": "open",
            "created_at": datetime.now(UTC).isoformat(),
        }
        | changes
    )


class Harness:
    def __init__(self, action: FakeAction | None = None, **kwargs: Any) -> None:
        self.action = action or FakeAction()
        self.published: list[PlaybookExecutionV1] = []
        options = {"mode": "host_probe", "whitelist": WHITELIST, "ttl_override_s": 1} | kwargs
        self.executor = Executor(
            PLAYBOOKS, {"nftables.block_ip": self.action}, publish=self.publish, **options
        )

    async def publish(self, execution: PlaybookExecutionV1) -> None:
        self.published.append(execution)

    def states(self) -> list[str]:
        return [e.state for e in self.published]

    def reasons(self) -> list[str | None]:
        return [e.reason for e in self.published]


def run(coro: Coroutine[Any, Any, None], settle: float = 0.3) -> None:
    async def main() -> None:
        await coro
        await asyncio.sleep(settle)

    asyncio.run(main())


def test_rule_only_incident_contained_then_rolled_back_at_ttl() -> None:
    """FR-401、FR-404：纯规则命中即执行；生效后附拦截证据；TTL 到期回滚。"""
    h = Harness()
    run(h.executor.on_incident(incident()), settle=1.3)

    assert h.states() == ["executing", "verifying", "contained", "contained", "rolled_back"]
    contained, evidence, rolled = h.published[2], h.published[3], h.published[4]
    assert contained.expires_at is not None and contained.device_ids == ["cam-02"]
    assert evidence.verify_result is not None
    assert evidence.verify_result.reason == "封禁规则已生效，已拦截 60 个数据包"  # D-072
    assert rolled.reason == "TTL 到期自动解除"
    assert h.action.calls == ["precheck", "execute", "verify", "rollback"]


def test_no_intercepted_traffic_noted_without_failing() -> None:
    h = Harness(FakeAction(packets=None), ttl_override_s=5)
    run(h.executor.on_incident(incident()))

    assert h.states()[-1] == "contained"
    assert h.published[-1].verify_result is not None
    assert h.published[-1].verify_result.reason == "封禁规则已生效，未观察到攻击流量"


def test_model_evidence_waits_for_confirmation() -> None:
    """FR-407：含模型证据时等确认事件后才执行。"""
    h = Harness(ttl_override_s=5)
    inc = incident(requires_confirmation=True)

    async def scenario() -> None:
        await h.executor.on_incident(inc)
        assert h.states() == ["pending"] and h.action.calls == []
        await h.executor.on_confirmation(
            CorrelatorConfirmationV1(
                schema_version="1.0.0",
                event_id=uuid.uuid4(),
                ts=datetime.now(UTC),
                incident_id=inc.id,
                actor="operator1",
                request_id="req-1",
            )
        )

    run(scenario())
    assert h.states()[:4] == ["pending", "executing", "verifying", "contained"]
    assert h.published[1].reason == "operator1 已确认"


def test_unconfirmed_execution_expires(monkeypatch: pytest.MonkeyPatch) -> None:
    """D-073：30 分钟内未确认即过期，不再执行。"""
    monkeypatch.setattr(executor_module, "CONFIRM_TIMEOUT", timedelta(seconds=0.1))
    h = Harness()
    run(h.executor.on_incident(incident(requires_confirmation=True)))

    assert h.states() == ["pending", "expired"]
    assert h.action.calls == []


def test_model_evidence_waits_without_executing() -> None:
    """FR-407：含模型证据时不自动执行，等待人工确认。"""
    h = Harness()
    run(h.executor.on_incident(incident(requires_confirmation=True)), settle=0.05)
    assert h.states() == ["pending"] and h.reasons() == ["含模型证据，等待人工确认"]
    assert h.action.calls == []


@pytest.mark.parametrize(
    ("kwargs", "changes", "reason"),
    [
        ({"whitelist": []}, {}, "未配置核心业务白名单，只告警不处置"),  # C-SEC-03
        ({}, {"source_ip": "172.30.0.5"}, "目标在核心业务白名单内，不处置"),  # FR-403
        ({}, {"source_ip": None}, "关联事件没有攻击源"),
    ],
)
def test_skipped_with_reason(kwargs: dict[str, Any], changes: dict[str, Any], reason: str) -> None:
    h = Harness(**kwargs)
    run(h.executor.on_incident(incident(**changes)))
    assert h.states() == ["skipped"] and h.reasons() == [reason]
    assert h.action.calls == []


def test_bypass_mode_only_notifies() -> None:
    """FR-1001：部署模式不在 requires_mode 内时只通知。"""
    h = Harness(mode="bypass")
    run(h.executor.on_incident(incident()))
    assert h.states() == ["notify_only"] and h.action.calls == []


@pytest.mark.parametrize(
    "changes", [{"mode": "monitor"}, {"rule_id": "HYD-X-0002"}, {"severity": "high"}]
)
def test_non_matching_incident_ignored(changes: dict[str, Any]) -> None:
    h = Harness()
    run(h.executor.on_incident(incident(**changes)))
    assert h.published == []


def test_replayed_incident_not_executed_twice() -> None:
    h = Harness(ttl_override_s=5)
    inc = incident()

    async def scenario() -> None:
        await h.executor.on_incident(inc)
        await asyncio.sleep(0.05)
        await h.executor.on_incident(inc)

    run(scenario())
    assert h.action.calls.count("execute") == 1


def test_same_target_mutually_exclusive() -> None:
    """C-BE-04：同一目标已有处置在执行时跳过。"""
    h = Harness(ttl_override_s=5)

    async def scenario() -> None:
        await h.executor.on_incident(incident())
        await asyncio.sleep(0.05)
        await h.executor.on_incident(incident())

    run(scenario())
    assert ("skipped", "同一目标已有处置在执行") in zip(h.states(), h.reasons(), strict=True)
    assert h.action.calls.count("execute") == 1


@pytest.mark.parametrize(
    ("fail", "reason", "calls"),
    [
        ("execute", "privileged-helper 不可达", ["precheck", "execute"]),
        ("verify", "封禁规则未在内核防火墙中生效", ["precheck", "execute", "verify", "rollback"]),
    ],
)
def test_failure_rolls_back_and_reports(fail: str, reason: str, calls: list[str]) -> None:
    """FR-406：失败时回滚已执行的部分，显示"处置失败"及原因。"""
    h = Harness(FakeAction(fail=fail))
    run(h.executor.on_incident(incident()))
    assert h.states()[-1] == "failed" and h.published[-1].reason == reason
    assert h.action.calls == calls


def test_manual_rollback_cancels_ttl() -> None:
    """FR-405：手动回滚后不再有 TTL 到期回滚。"""
    h = Harness()

    async def scenario() -> None:
        await h.executor.on_incident(incident())
        await asyncio.sleep(0.05)
        execution = h.published[-1]
        await h.executor.on_rollback(
            PlaybookRollbackV1(
                schema_version="1.0.0",
                event_id=uuid.uuid4(),
                ts=datetime.now(UTC),
                execution_id=execution.id,
                actor="operator1",
                request_id="req-2",
            )
        )

    run(scenario(), settle=1.3)
    assert h.states().count("rolled_back") == 1
    rolled = next(e for e in h.published if e.state == "rolled_back")
    assert rolled.reason == "由 operator1 手动回滚"


def test_resume_after_restart() -> None:
    """重启：已生效的到期回滚；执行到一半的撤销并记为失败；等待确认的超时即过期。"""
    h = Harness()
    template = PlaybookExecutionV1.model_validate(
        {
            "schema_version": "1.1.0",
            "event_id": str(uuid.uuid4()),
            "ts": datetime.now(UTC).isoformat(),
            "id": "exe-1",
            "playbook_id": "isolate-attacker",
            "playbook_version": "1.0.0",
            "incident_id": "inc-1",
            "device_ids": ["cam-02"],
            "target": "172.30.0.100",
            "state": "contained",
            "reason": None,
            "ttl_s": 150,
            "expires_at": (datetime.now(UTC) + timedelta(seconds=0.1)).isoformat(),
            "verify_result": {"passed": True, "reason": None},
        }
    )
    h.executor.restore(template)
    h.executor.restore(
        template.model_copy(update={"id": "exe-2", "state": "executing", "target": "172.30.0.101"})
    )
    h.executor.restore(
        template.model_copy(
            update={"id": "exe-3", "state": "pending", "ts": datetime.now(UTC) - timedelta(hours=1)}
        )
    )
    run(h.executor.resume())

    final = {e.id: (e.state, e.reason) for e in h.published}
    assert final == {
        "exe-1": ("rolled_back", "TTL 到期自动解除"),
        "exe-2": ("failed", "执行中断：处置执行器重启"),
        "exe-3": ("expired", "30 分钟内未确认，已过期"),
    }
