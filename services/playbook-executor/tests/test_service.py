"""服务接入（TK-050）：真实 nats-server 加真实的 helper 套接字服务（nft 以假实现代替）。"""

import asyncio
import uuid
from datetime import UTC, datetime
from pathlib import Path

import nats
import nats.js.errors
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import (
    Encoding,
    NoEncryption,
    PrivateFormat,
    PublicFormat,
)
from test_nftables import FakeNft

from playbook_executor.service import (
    COMMAND_STREAM,
    CONFIRMATION_SUBJECT,
    EXECUTION_STREAM,
    EXECUTION_SUBJECT,
    INCIDENT_SUBJECT,
    MAX_AGE_S,
    ROLLBACK_SUBJECT,
    ExecutorConfig,
    build,
    subscribe,
)
from privileged_helper.server import HelperConfig, start
from py_common.bus import Bus
from py_contracts.events.hyd_correlator_incident_v1_schema import CorrelatorIncidentV1
from py_contracts.events.hyd_playbook_execution_v1_schema import PlaybookExecutionV1

ROOT = Path(__file__).resolve().parents[3]
KEY = Ed25519PrivateKey.generate()


def incident() -> CorrelatorIncidentV1:
    now = datetime.now(UTC)
    return CorrelatorIncidentV1.model_validate(
        {
            "schema_version": "1.2.0",
            "event_id": str(uuid.uuid4()),
            "ts": now.isoformat(),
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
            "created_at": now.isoformat(),
        }
    )


def configs(tmp_path: Path, nats_url: str) -> tuple[ExecutorConfig, HelperConfig]:
    private, public = tmp_path / "executor.key", tmp_path / "helper.pub"
    private.write_bytes(KEY.private_bytes(Encoding.PEM, PrivateFormat.PKCS8, NoEncryption()))
    public.write_bytes(
        KEY.public_key().public_bytes(Encoding.PEM, PublicFormat.SubjectPublicKeyInfo)
    )
    socket = tmp_path / "helper.sock"
    executor = ExecutorConfig(
        nats_url=nats_url,
        site_file=ROOT / "demo/scenarios/site.yaml",
        playbooks_dir=ROOT / "playbooks",
        helper_socket=socket,
        signing_key_file=private,
        ttl_override_s=60,
    )
    return executor, HelperConfig(socket_path=socket, public_key_file=public)


def test_incident_contained_and_not_repeated_after_restart(nats_url: str, tmp_path: Path) -> None:
    config, helper_config = configs(tmp_path, nats_url)
    nft = FakeNft()

    async def scenario() -> list[str]:
        server = await start(helper_config, nft)
        raw = await nats.connect(nats_url)
        for name in (
            "HYD_INCIDENT",
            EXECUTION_STREAM,
            COMMAND_STREAM,
        ):  # 测试会话共用 NATS，与其他用例隔离
            try:
                await raw.jetstream().delete_stream(name)
            except nats.js.errors.NotFoundError:
                pass
        await raw.close()
        bus = await Bus.connect(nats_url, name="test", timeout_s=2)
        await bus.ensure_stream("HYD_INCIDENT", [INCIDENT_SUBJECT], 3600)
        await bus.ensure_stream(EXECUTION_STREAM, [EXECUTION_SUBJECT], MAX_AGE_S)
        await bus.ensure_stream(COMMAND_STREAM, [CONFIRMATION_SUBJECT, ROLLBACK_SUBJECT], MAX_AGE_S)
        states: list[str] = []
        contained = asyncio.Event()

        async def on_execution(execution: PlaybookExecutionV1) -> None:
            states.append(execution.state)
            if execution.state == "contained":
                contained.set()

        await bus.subscribe(EXECUTION_SUBJECT, PlaybookExecutionV1, on_execution)
        await subscribe(build(config, bus), bus)
        await bus.js_publish(INCIDENT_SUBJECT, incident())
        await asyncio.wait_for(contained.wait(), 5)

        # 重启：重放执行记录恢复状态，重放的关联事件不再执行
        restarted = await Bus.connect(nats_url, name="restarted", timeout_s=2)
        await subscribe(build(config, restarted), restarted)
        await asyncio.sleep(0.5)
        await restarted.close()
        await bus.close()
        server.close()
        return states

    states = asyncio.run(scenario())
    assert states[:3] == ["executing", "verifying", "contained"]
    assert states.count("executing") == 1
    assert nft.blocked == {"172.30.0.100": 60}
