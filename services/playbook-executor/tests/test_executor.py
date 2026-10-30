"""处置编排（TK-050）：触发、白名单、模式、互斥、失败回滚、TTL。"""

import asyncio
import uuid
from collections.abc import Coroutine
from datetime import UTC, datetime
from ipaddress import ip_network
from pathlib import Path
from typing import Any

import pytest

from playbook_executor.action import ActionContext, ActionError, Result
from playbook_executor.executor import Executor
from playbook_executor.playbooks import load_playbooks
from py_contracts.events.hyd_playbook_execution_v1_schema import PlaybookExecutionV1
from py_contracts.events.incident_schema import Incident

ROOT = Path(__file__).resolve().parents[3]
PLAYBOOKS = load_playbooks(ROOT / "playbooks")
WHITELIST = [ip_network("172.30.0.0/28")]


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
    """FR-401、FR-404：纯规则命中即执行；确认规则生效即转已处置；TTL 到期回滚。"""
    h = Harness()
    run(h.executor.on_incident(incident()), settle=1.3)

    assert h.states() == ["executing", "verifying", "contained", "rolled_back"]
    contained, rolled = h.published[2], h.published[3]
    assert contained.expires_at is not None and contained.device_ids == ["cam-02"]
    assert contained.verify_result is not None
    assert contained.verify_result.reason == "封禁规则已在内核防火墙中生效"  # D-072
    assert rolled.reason == "TTL 到期自动解除"
    assert h.action.calls == ["precheck", "execute", "verify", "rollback"]


def test_model_evidence_waits_without_executing() -> None:
    """FR-407：含模型证据时不自动执行，等待人工确认。"""
    h = Harness()
    run(h.executor.on_incident(incident(requires_confirmation=True)))
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
