"""处置执行写审计（G-13、TK-050）：对真实 PostgreSQL 与 nats-server 运行。"""

import asyncio
import uuid
from datetime import UTC, datetime

import nats
import nats.js.errors
import pytest
from sqlalchemy import select

from api_server import executions
from api_server.audit import audit_log
from api_server.config import ApiConfig
from api_server.db import create_engine
from py_common.bus import Bus
from py_contracts.events.hyd_playbook_execution_v1_schema import PlaybookExecutionV1

STREAM = "HYD_PLAYBOOK"


def execution(state: str, reason: str | None = None) -> PlaybookExecutionV1:
    return PlaybookExecutionV1.model_validate(
        {
            "schema_version": "1.1.0",
            "event_id": str(uuid.uuid4()),
            "ts": datetime.now(UTC).isoformat(),
            "id": "exe-audit",
            "playbook_id": "isolate-attacker",
            "playbook_version": "1.0.0",
            "incident_id": "inc-1",
            "device_ids": ["cam-02"],
            "target": "172.30.0.100",
            "state": state,
            "reason": reason,
            "ttl_s": 150,
            "expires_at": None,
            "verify_result": None,
        }
    )


async def audited(config: ApiConfig) -> list[tuple[str, str, str]]:
    engine = create_engine(config)
    try:
        async with engine.connect() as conn:
            rows = await conn.execute(
                select(audit_log.c.actor, audit_log.c.action, audit_log.c.target)
                .where(audit_log.c.actor == executions.ACTOR)
                .order_by(audit_log.c.id)
            )
            return [tuple(r) for r in rows]
    finally:
        await engine.dispose()


def test_each_state_change_audited_once_across_restart(
    db: tuple[ApiConfig, ApiConfig], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(executions, "RESUBSCRIBE_S", 0.1)
    config = db[1]
    states = [
        execution("executing"),
        execution("contained"),
        execution("rolled_back", "TTL 到期自动解除"),
    ]

    async def scenario() -> list[tuple[str, str, str]]:
        raw = await nats.connect(config.nats_url)
        try:
            await raw.jetstream().delete_stream(STREAM)
        except nats.js.errors.NotFoundError:
            pass
        await raw.close()
        bus = await Bus.connect(config.nats_url, name="test", timeout_s=2)
        engine = create_engine(config)
        # 流尚未创建（executor 未启动）：记录后重试
        task = asyncio.create_task(executions.follow(bus, engine))
        await asyncio.sleep(0.3)
        await bus.ensure_stream(STREAM, [executions.SUBJECT], 3600)
        await asyncio.wait_for(task, 5)
        for e in states:
            await bus.js_publish(executions.SUBJECT, e)
        await asyncio.sleep(0.5)

        # 重启：从最近审计时刻前一分钟起重放，已写过的跳过
        restarted = await Bus.connect(config.nats_url, name="restarted", timeout_s=2)
        await executions.follow(restarted, engine)
        await asyncio.sleep(0.5)
        await restarted.close()
        await bus.close()
        await engine.dispose()
        return await audited(config)

    assert asyncio.run(scenario()) == [
        ("playbook-executor", "playbook.executing", "172.30.0.100"),
        ("playbook-executor", "playbook.contained", "172.30.0.100"),
        ("playbook-executor", "playbook.rolled_back", "172.30.0.100"),
    ]
