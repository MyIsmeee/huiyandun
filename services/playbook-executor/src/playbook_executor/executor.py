"""处置编排（TK-050，设计 docs/design/050-containment.md）：关联事件 → Playbook → 四接口 → TTL 到期回滚。

判定只依据关联事件的结构化字段与 Playbook，不 import 任何 LLM 客户端（G-03、D-01）。状态只在本进程内维护，
每次变化发布一条 hyd.playbook.execution.v1；重启时由 restore 以流中各执行的最后状态恢复。
"""

import asyncio
import logging
import uuid
from collections.abc import Awaitable, Callable, Coroutine
from datetime import UTC, datetime, timedelta
from ipaddress import IPv4Network, IPv6Network, ip_address
from typing import Any

from playbook_executor.action import Action, ActionContext, ActionError
from playbook_executor.playbooks import Playbook
from py_contracts.events.hyd_correlator_confirmation_v1_schema import CorrelatorConfirmationV1
from py_contracts.events.hyd_playbook_execution_v1_schema import PlaybookExecutionV1
from py_contracts.events.hyd_playbook_rollback_v1_schema import PlaybookRollbackV1
from py_contracts.events.incident_schema import Incident
from py_contracts.events.playbook_execution_schema import VerifyResult

SCHEMA_VERSION = "1.1.0"  # 1.1：device_ids、reason，只通知、跳过、过期状态
CONFIRM_TIMEOUT = timedelta(minutes=30)  # D-073
EVIDENCE_WINDOW_S, EVIDENCE_INTERVAL_S = 30.0, 5.0  # D-072
# 执行 ID 由 Playbook 与关联事件派生：重放同一关联事件不会重复执行
EXECUTION_NAMESPACE = uuid.UUID("2c4b9e71-5a0d-4f3e-8b6a-9d1c7e2f4a03")

type Network = IPv4Network | IPv6Network
type Publish = Callable[[PlaybookExecutionV1], Awaitable[None]]

log = logging.getLogger(__name__)


class Executor:
    def __init__(
        self,
        playbooks: list[Playbook],
        actions: dict[str, Action],
        mode: str,
        whitelist: list[Network],
        publish: Publish,
        ttl_override_s: int | None = None,
    ) -> None:
        self._playbooks = {p.id: p for p in playbooks}
        self._actions = actions  # 键为 "<adapter>.<action>"
        self._mode = mode
        self._whitelist = whitelist
        self._publish = publish
        self._ttl_override = ttl_override_s  # 主剧本覆盖为 150 s（FR-404）
        self._executions: dict[str, PlaybookExecutionV1] = {}
        self._active: set[str] = set()  # 执行中或已生效的目标，同一目标互斥（C-BE-04）
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self._background: set[asyncio.Task[None]] = set()

    # ── 输入 ──────────────────────────────────────────────

    async def on_incident(self, incident: Incident) -> None:
        if incident.mode != "enforce":  # monitor 只告警不触发处置（C-SEC-04、D-068）
            return
        for playbook in self._playbooks.values():
            trigger = playbook.trigger
            if (
                incident.rule_id not in trigger.rule_ids
                or incident.severity not in trigger.severity
            ):
                continue
            execution_id = str(uuid.uuid5(EXECUTION_NAMESPACE, playbook.id + incident.id))
            if execution_id in self._executions:
                continue  # 重放的关联事件
            execution = self._new(playbook, incident, execution_id)
            if self._mode not in playbook.requires_mode:
                await self._update(
                    execution, state="notify_only", reason="当前部署模式不支持执行，仅通知"
                )
            elif reason := self._skip_reason(incident):
                await self._update(execution, state="skipped", reason=reason)
            elif incident.requires_confirmation:
                pending = await self._update(execution, reason="含模型证据，等待人工确认")
                self._spawn(execution_id, self._expire(pending, CONFIRM_TIMEOUT))
            else:
                self._spawn(execution_id, self._run(execution))

    async def on_confirmation(self, confirmation: CorrelatorConfirmationV1) -> None:
        for execution in list(self._executions.values()):
            if execution.incident_id == confirmation.incident_id and execution.state == "pending":
                log.info(
                    "playbook.confirmed",
                    extra={"execution_id": execution.id, "actor": confirmation.actor},
                )
                self._spawn(execution.id, self._run(execution, f"{confirmation.actor} 已确认"))

    async def on_rollback(self, request: PlaybookRollbackV1) -> None:
        execution = self._executions.get(request.execution_id)
        if execution is None or execution.state != "contained":
            log.warning("playbook.rollback_ignored", extra={"execution_id": request.execution_id})
            return
        self._cancel(execution.id)
        await self._roll_back(execution, f"由 {request.actor} 手动回滚")  # FR-405

    # ── 重启恢复 ───────────────────────────────────────────

    def restore(self, execution: PlaybookExecutionV1) -> None:
        """重放流中的执行记录，保留各执行的最后状态；全部重放后调用 resume。"""
        self._executions[execution.id] = execution

    async def resume(self) -> None:
        now = datetime.now(UTC)
        for execution in list(self._executions.values()):
            if execution.state == "pending":
                self._spawn(
                    execution.id, self._expire(execution, CONFIRM_TIMEOUT - (now - execution.ts))
                )
            elif execution.state == "contained" and execution.expires_at is not None:
                self._active.add(execution.target)
                self._spawn(execution.id, self._ttl(execution))
            elif execution.state in ("executing", "verifying"):
                # 执行到一半时退出：撤销可能已写入的封禁，如实记为失败
                await self._undo(execution)
                await self._update(execution, state="failed", reason="执行中断：处置执行器重启")

    # ── 编排 ──────────────────────────────────────────────

    def _new(
        self, playbook: Playbook, incident: Incident, execution_id: str
    ) -> PlaybookExecutionV1:
        return PlaybookExecutionV1(
            schema_version=SCHEMA_VERSION,
            event_id=uuid.uuid4(),
            ts=datetime.now(UTC),
            id=execution_id,
            playbook_id=playbook.id,
            playbook_version=playbook.version,
            incident_id=incident.id,
            device_ids=incident.device_ids,
            target=str(incident.source_ip) if incident.source_ip else "",
            state="pending",
            reason=None,
            ttl_s=self._ttl_override or playbook.ttl_s,
            expires_at=None,
            verify_result=None,
        )

    def _skip_reason(self, incident: Incident) -> str | None:
        """白名单（C-SEC-03、FR-403）：未配置时只告警；目标在其中时不处置。"""
        if incident.source_ip is None:
            return "关联事件没有攻击源"
        if not self._whitelist:
            return "未配置核心业务白名单，只告警不处置"
        if any(incident.source_ip in net for net in self._whitelist):
            return "目标在核心业务白名单内，不处置"
        return None

    def _steps(self, execution: PlaybookExecutionV1) -> list[tuple[Action, ActionContext]]:
        playbook = self._playbooks[execution.playbook_id]
        target = ip_address(execution.target)
        return [
            (
                self._actions[f"{s.adapter}.{s.action}"],
                ActionContext(target=target, ttl_s=execution.ttl_s, params=s.params),
            )
            for s in playbook.actions
        ]

    async def _run(self, execution: PlaybookExecutionV1, reason: str | None = None) -> None:
        if execution.target in self._active:
            await self._update(execution, state="skipped", reason="同一目标已有处置在执行")
            return
        self._active.add(execution.target)
        execution = await self._update(execution, state="executing", reason=reason)
        done: list[tuple[Action, ActionContext]] = []
        verified = None
        try:
            for action, ctx in self._steps(execution):
                checked = await action.precheck(ctx)
                if not checked.passed:
                    raise ActionError(checked.reason or "预检未通过")
                await action.execute(ctx)
                done.append((action, ctx))
            execution = await self._update(execution, state="verifying")
            for action, ctx in done:
                verified = await action.verify(ctx)
                if not verified.passed:
                    raise ActionError(verified.reason or "校验未通过")
        except ActionError as e:
            # 回滚已执行的部分，设备保持告警态（FR-406）
            for action, ctx in done:
                await self._safe_rollback(action, ctx)
            self._active.discard(execution.target)
            await self._update(execution, state="failed", reason=str(e))
            return
        execution = await self._update(
            execution,
            state="contained",
            expires_at=datetime.now(UTC) + timedelta(seconds=execution.ttl_s),
            verify_result=VerifyResult(passed=True, reason=verified.reason if verified else None),
        )
        self._spawn(execution.id, self._ttl(execution))
        evidence = asyncio.create_task(self._evidence(execution))
        self._background.add(evidence)  # 保留引用直到结束，避免任务被回收
        evidence.add_done_callback(self._background.discard)

    async def _evidence(self, execution: PlaybookExecutionV1) -> None:
        """生效后 30 s 内读拦截计数，作为证据写入 verify_result（D-072），不影响已生效的判定。"""
        loop = asyncio.get_running_loop()
        deadline = loop.time() + EVIDENCE_WINDOW_S
        while loop.time() < deadline:
            await asyncio.sleep(EVIDENCE_INTERVAL_S)
            packets = sum([await a.intercepted(c) or 0 for a, c in self._steps(execution)])
            if packets:
                await self._annotate(execution.id, f"封禁规则已生效，已拦截 {packets} 个数据包")
                return
        await self._annotate(execution.id, "封禁规则已生效，未观察到攻击流量")

    async def _annotate(self, execution_id: str, reason: str) -> None:
        current = self._executions[execution_id]
        if current.state == "contained":
            await self._update(current, verify_result=VerifyResult(passed=True, reason=reason))

    async def _ttl(self, execution: PlaybookExecutionV1) -> None:
        assert execution.expires_at is not None
        await asyncio.sleep(max(0.0, (execution.expires_at - datetime.now(UTC)).total_seconds()))
        # 内核已按超时删除元素；再解封一次确保一致，并记录回滚（FR-404）
        await self._roll_back(self._executions[execution.id], "TTL 到期自动解除")

    async def _expire(self, execution: PlaybookExecutionV1, after: timedelta) -> None:
        await asyncio.sleep(max(0.0, after.total_seconds()))
        current = self._executions[execution.id]
        if current.state == "pending":
            await self._update(current, state="expired", reason="30 分钟内未确认，已过期")

    async def _roll_back(self, execution: PlaybookExecutionV1, reason: str) -> None:
        await self._undo(execution)
        self._active.discard(execution.target)
        await self._update(execution, state="rolled_back", reason=reason)

    async def _undo(self, execution: PlaybookExecutionV1) -> None:
        for action, ctx in self._steps(execution):
            await self._safe_rollback(action, ctx)

    @staticmethod
    async def _safe_rollback(action: Action, ctx: ActionContext) -> None:
        try:
            await action.rollback(ctx)
        except ActionError:
            # 封禁仍会按内核超时到期解除；记录后继续，不掩盖原始结果
            log.exception("playbook.rollback_failed", extra={"target": str(ctx.target)})

    async def _update(self, execution: PlaybookExecutionV1, **changes: Any) -> PlaybookExecutionV1:
        updated = execution.model_copy(
            update=changes | {"event_id": uuid.uuid4(), "ts": datetime.now(UTC)}
        )
        self._executions[updated.id] = updated
        log.info(
            "playbook.execution",
            extra={"execution_id": updated.id, "state": updated.state, "reason": updated.reason},
        )
        await self._publish(updated)
        return updated

    def _spawn(self, execution_id: str, coro: Coroutine[Any, Any, None]) -> None:
        self._cancel(execution_id)
        self._tasks[execution_id] = asyncio.create_task(coro)

    def _cancel(self, execution_id: str) -> None:
        task = self._tasks.pop(execution_id, None)
        if task is not None and task is not asyncio.current_task():
            task.cancel()
