"""playbook-executor 服务（TK-050）：订阅关联事件、确认与回滚请求，发布处置执行状态。

启动顺序：先重放近 24 小时（TTL 上限）的执行记录恢复状态并继续计时，再订阅确认、关联事件与回滚请求。
确认与回滚请求的流由本服务（消费方）创建，api-server 只发布。
"""

import asyncio
import logging
from datetime import UTC, datetime, timedelta
from pathlib import Path

import nats
import yaml
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import load_pem_private_key
from pydantic import Field

from playbook_executor.executor import CONFIRM_TIMEOUT, Executor
from playbook_executor.nftables import BlockIp, Helper
from playbook_executor.playbooks import load_playbooks
from py_common.bus import Bus
from py_common.config import ServiceConfig, load_config
from py_common.log import configure_logging
from py_contracts.config.site_schema import SiteConfig
from py_contracts.events.hyd_correlator_confirmation_v1_schema import CorrelatorConfirmationV1
from py_contracts.events.hyd_correlator_incident_v1_schema import CorrelatorIncidentV1
from py_contracts.events.hyd_playbook_execution_v1_schema import PlaybookExecutionV1
from py_contracts.events.hyd_playbook_rollback_v1_schema import PlaybookRollbackV1

EXECUTION_SUBJECT = "hyd.playbook.execution.v1"
CONFIRMATION_SUBJECT = "hyd.correlator.confirmation.v1"
ROLLBACK_SUBJECT = "hyd.playbook.rollback.v1"
INCIDENT_SUBJECT = "hyd.correlator.incident.v1"
# 处置记录与操作员命令保留 365 天（HYD-ARCH-001 §10.2）
EXECUTION_STREAM, COMMAND_STREAM = "HYD_PLAYBOOK", "HYD_COMMAND"
MAX_AGE_S = 365 * 86400
# 重启重放范围：执行记录覆盖 TTL 上限（C-BE-05）；停机期间的关联事件只补近 5 分钟，避免很久以前的攻击
# 在重启后才被封禁；回滚请求只补近 1 分钟（已结束的执行会忽略）
EXECUTION_REPLAY = timedelta(seconds=86400)
INCIDENT_REPLAY = timedelta(minutes=5)
ROLLBACK_REPLAY = timedelta(minutes=1)
PUBLISH_RETRY_S = 1.0

log = logging.getLogger(__name__)


class ExecutorConfig(ServiceConfig):
    site_file: Path = Field(
        Path("/etc/hyd/site.yaml"), description="站点配置：部署模式与核心业务白名单（C-SEC-03）"
    )
    playbooks_dir: Path = Field(Path("/etc/hyd/playbooks"), description="Playbook 目录 playbooks/")
    helper_socket: Path = Field(
        Path("/run/hyd-helper/helper.sock"), description="privileged-helper 的套接字"
    )
    signing_key_file: Path = Field(
        Path("/run/secrets/executor_signing_key"),
        description="向 privileged-helper 签名指令的 Ed25519 私钥（PEM，D-074）",
    )
    ttl_override_s: int | None = Field(
        None, ge=1, le=86400, description="覆盖全部 Playbook 的 TTL，主剧本为 150（FR-404）"
    )
    heartbeat_file: Path = Field(
        Path("/tmp/hyd-playbook-alive"), description="事件循环每秒更新其修改时间，供健康检查判断"
    )


def load_key(path: Path) -> Ed25519PrivateKey:
    key = load_pem_private_key(path.read_bytes(), password=None)
    if not isinstance(key, Ed25519PrivateKey):
        raise TypeError(f"{path} 不是 Ed25519 私钥")
    return key


def build(config: ExecutorConfig, bus: Bus) -> Executor:
    site = SiteConfig.model_validate(yaml.safe_load(config.site_file.read_text(encoding="utf-8")))

    async def publish(execution: PlaybookExecutionV1) -> None:
        # 状态变化必须送达（api-server 据此显示设备状态、写审计）；断线时一直重试，event_id 去重
        while True:
            try:
                await bus.js_publish(EXECUTION_SUBJECT, execution)
                return
            except (nats.errors.Error, TimeoutError) as e:
                log.warning(
                    "playbook.publish_failed",
                    extra={"execution_id": execution.id, "error": repr(e)},
                )
                await asyncio.sleep(PUBLISH_RETRY_S)

    helper = Helper(config.helper_socket, load_key(config.signing_key_file))
    return Executor(
        load_playbooks(config.playbooks_dir),
        {"nftables.block_ip": BlockIp(helper)},
        mode=site.site.mode,
        whitelist=site.whitelist,
        publish=publish,
        ttl_override_s=config.ttl_override_s,
    )


async def subscribe(executor: Executor, bus: Bus) -> None:
    now = datetime.now(UTC)

    async def restore(execution: PlaybookExecutionV1) -> None:
        executor.restore(execution)

    await bus.js_subscribe(EXECUTION_SUBJECT, PlaybookExecutionV1, restore, now - EXECUTION_REPLAY)
    await executor.resume()
    await bus.js_subscribe(
        CONFIRMATION_SUBJECT,
        CorrelatorConfirmationV1,
        executor.on_confirmation,
        now - CONFIRM_TIMEOUT,
    )
    await bus.js_subscribe(
        INCIDENT_SUBJECT, CorrelatorIncidentV1, executor.on_incident, now - INCIDENT_REPLAY
    )
    await bus.js_subscribe(
        ROLLBACK_SUBJECT, PlaybookRollbackV1, executor.on_rollback, now - ROLLBACK_REPLAY
    )


async def serve(config: ExecutorConfig) -> None:
    bus = await Bus.connect(
        config.nats_url, name="playbook-executor", timeout_s=config.nats_timeout_s
    )
    await bus.ensure_stream(EXECUTION_STREAM, [EXECUTION_SUBJECT], MAX_AGE_S)
    await bus.ensure_stream(COMMAND_STREAM, [CONFIRMATION_SUBJECT, ROLLBACK_SUBJECT], MAX_AGE_S)
    executor = build(config, bus)
    await subscribe(executor, bus)
    log.info("playbook.started", extra={"playbooks_dir": str(config.playbooks_dir)})
    while True:
        config.heartbeat_file.touch()
        await asyncio.sleep(1)


def main() -> None:
    """hyd-playbook：常驻处置执行器。"""
    config = load_config(ExecutorConfig)
    configure_logging("playbook-executor", config.log_level)
    asyncio.run(serve(config))
