"""hyd-api demo-reset：回滚仍为 contained 的处置（逐条审计），再广播复位使 correlator 清空去重期。"""

import asyncio
import uuid
from datetime import UTC, datetime

from sqlalchemy import select

from api_server.audit import audit_log
from api_server.cli import EXECUTION_SUBJECT, RESET_ACTOR, RESET_SUBJECT, demo_reset
from api_server.config import ApiConfig
from api_server.containment import ROLLBACK_SUBJECT
from api_server.db import transaction
from py_common.bus import Bus
from py_contracts.events.hyd_demo_reset_v1_schema import DemoResetV1
from py_contracts.events.hyd_playbook_execution_v1_schema import PlaybookExecutionV1
from py_contracts.events.hyd_playbook_rollback_v1_schema import PlaybookRollbackV1


def execution(execution_id: str, state: str, target: str) -> PlaybookExecutionV1:
    return PlaybookExecutionV1.model_validate(
        {
            "schema_version": "1.1.0", "event_id": str(uuid.uuid4()),
            "ts": datetime.now(UTC).isoformat(), "id": execution_id,
            "playbook_id": "isolate-attacker", "playbook_version": "1.0.0", "incident_id": "inc-1",
            "device_ids": ["cam-07"], "target": target, "state": state, "reason": None,
            "ttl_s": 1800, "expires_at": None, "verify_result": None,
        }
    )  # fmt: skip


def test_demo_reset_rolls_back_contained_and_broadcasts(
    db: tuple[ApiConfig, ApiConfig], nats_url: str
) -> None:
    suffix = uuid.uuid4().hex[:8]
    active, finished = f"exe-active-{suffix}", f"exe-finished-{suffix}"
    rollbacks: list[PlaybookRollbackV1] = []
    resets: list[DemoResetV1] = []

    async def main() -> list[str]:
        bus = await Bus.connect(nats_url, name="test-demo-reset", timeout_s=2)
        try:
            await bus.ensure_stream("HYD_PLAYBOOK", [EXECUTION_SUBJECT], 3600)
            await bus.ensure_stream("HYD_COMMAND", [ROLLBACK_SUBJECT], 3600)
            for event in (
                execution(active, "contained", "172.30.0.100"),
                execution(finished, "contained", "172.30.0.101"),
                execution(finished, "rolled_back", "172.30.0.101"),  # 最新状态已回滚：跳过
            ):
                await bus.js_publish(EXECUTION_SUBJECT, event)

            async def on_rollback(event: PlaybookRollbackV1) -> None:
                rollbacks.append(event)

            async def on_reset(event: DemoResetV1) -> None:
                resets.append(event)

            await bus.subscribe(ROLLBACK_SUBJECT, PlaybookRollbackV1, on_rollback)
            await bus.subscribe(RESET_SUBJECT, DemoResetV1, on_reset)
            rolled_back = await demo_reset(db[1], bus)
            await asyncio.sleep(0.3)
            return rolled_back
        finally:
            await bus.close()

    rolled_back = asyncio.run(main())

    assert active in rolled_back and finished not in rolled_back
    mine = [r for r in rollbacks if r.execution_id in (active, finished)]
    assert [(r.execution_id, r.actor) for r in mine] == [(active, RESET_ACTOR)]
    (reset,) = resets
    assert reset.actor == RESET_ACTOR and reset.request_id == mine[0].request_id

    async def audited() -> list[tuple[str, str, str]]:
        async with transaction(db[1]) as conn:
            rows = await conn.execute(
                select(audit_log.c.actor, audit_log.c.action, audit_log.c.target).where(
                    audit_log.c.request_id == reset.request_id
                )
            )
            return sorted(tuple(r) for r in rows)

    rows = asyncio.run(audited())
    assert (RESET_ACTOR, "demo.reset", "correlator") in rows
    assert (RESET_ACTOR, "playbook.rollback_requested", "172.30.0.100") in rows
    assert all(target != "172.30.0.101" for _, _, target in rows)
