"""命令行入口 hyd-audit：run 周期封存审计日志；verify 校验全部封存记录，不一致时以 1 退出。"""

import argparse
import asyncio
import logging
import sys
from datetime import UTC, datetime

from pydantic import Field
from sqlalchemy.exc import DBAPIError

from api_server.config import DbConfig
from api_server.db import transaction
from audit_service.seal import seal_pending, verify
from py_common.config import load_config
from py_common.log import configure_logging

log = logging.getLogger(__name__)


class AuditConfig(DbConfig):
    seal_interval_s: float = Field(
        3600, ge=60, le=86400, description="检查并封存已结束日期的周期，单位秒"
    )


async def run(config: AuditConfig) -> None:
    while True:
        try:
            async with transaction(config) as conn:
                sealed = await seal_pending(conn, datetime.now(UTC))
            for day in sealed:
                log.info("audit.sealed", extra={"day": day.isoformat()})
        except (OSError, DBAPIError):
            # 数据库不可达时下个周期重试；未封存日期会一并补齐
            log.exception("audit.seal_failed")
        await asyncio.sleep(config.seal_interval_s)


async def check(config: AuditConfig) -> list[str]:
    async with transaction(config) as conn:
        return [day.isoformat() for day in await verify(conn)]


def main() -> None:
    parser = argparse.ArgumentParser(prog="hyd-audit")
    parser.add_argument("command", choices=["run", "verify"])
    args = parser.parse_args()

    config = load_config(AuditConfig)
    configure_logging("audit-service", config.log_level)
    if args.command == "run":
        asyncio.run(run(config))
    elif failed := asyncio.run(check(config)):
        sys.exit(f"审计日志与封存记录不一致的日期：{', '.join(failed)}")
    else:
        print("审计日志与全部封存记录一致")
