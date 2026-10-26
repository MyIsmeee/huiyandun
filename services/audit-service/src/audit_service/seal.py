"""审计日志每日哈希链封存（HYD-ARCH-001 §10.1、G-13）。

每个 UTC 自然日一条封存记录：hash = SHA-256(前一日 hash ‖ 当日全部记录按 id 排序的规范化 JSON 行)，
首日的前一 hash 为 32 个零字节。当日无记录同样封存，链条不留空档。已封存日期内的记录被修改、删除
或补插后，该日校验失败。
"""

import hashlib
import json
from datetime import UTC, date, datetime, time, timedelta

from sqlalchemy import (
    Column,
    Date,
    Integer,
    LargeBinary,
    MetaData,
    Row,
    Table,
    func,
    insert,
    select,
)
from sqlalchemy.ext.asyncio import AsyncConnection

from api_server.audit import audit_log

GENESIS = bytes(32)
DAY = timedelta(days=1)
# 跨零点的事务可能在零点后才提交；等待远超语句超时后再封存前一日
GRACE = timedelta(minutes=10)

# 表结构由 api-server 迁移 0003 定义
audit_seal = Table(
    "audit_seal",
    MetaData(),
    Column("day", Date, primary_key=True),
    Column("record_count", Integer),
    Column("prev_hash", LargeBinary),
    Column("hash", LargeBinary),
)


def _canonical(row: Row) -> bytes:
    fields = {c: getattr(row, c) for c in ("actor", "action", "target", "before", "after")}
    data = fields | {"id": row.id, "ts": row.ts.isoformat(), "request_id": row.request_id}
    return json.dumps(data, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()


async def _digest(conn: AsyncConnection, day: date, prev_hash: bytes) -> tuple[bytes, int]:
    start = datetime.combine(day, time(), UTC)
    rows = await conn.execute(
        select(audit_log)
        .where(audit_log.c.ts >= start, audit_log.c.ts < start + DAY)
        .order_by(audit_log.c.id)
    )
    digest, count = hashlib.sha256(prev_hash), 0
    for row in rows:
        digest.update(_canonical(row) + b"\n")
        count += 1
    return digest.digest(), count


async def seal_pending(conn: AsyncConnection, now: datetime) -> list[date]:
    """封存已结束且超过 GRACE 的全部未封存日期，返回本次封存的日期。"""
    last = (
        await conn.execute(
            select(audit_seal.c.day, audit_seal.c.hash).order_by(audit_seal.c.day.desc()).limit(1)
        )
    ).first()
    if last is not None:
        day, prev_hash = last.day + DAY, last.hash
    else:
        first_ts = await conn.scalar(select(func.min(audit_log.c.ts)))
        if first_ts is None:
            return []
        day, prev_hash = first_ts.astimezone(UTC).date(), GENESIS

    sealed = []
    while datetime.combine(day + DAY, time(), UTC) + GRACE <= now:
        digest, count = await _digest(conn, day, prev_hash)
        await conn.execute(
            insert(audit_seal).values(day=day, record_count=count, prev_hash=prev_hash, hash=digest)
        )
        sealed.append(day)
        day, prev_hash = day + DAY, digest
    return sealed


async def verify(conn: AsyncConnection) -> list[date]:
    """按当前审计日志重算全部封存记录，返回校验失败的日期；空列表表示一致。"""
    failed = []
    seals = (await conn.execute(select(audit_seal).order_by(audit_seal.c.day))).all()
    first_ts = await conn.scalar(select(func.min(audit_log.c.ts)))
    if seals and first_ts is not None and first_ts.astimezone(UTC).date() < seals[0].day:
        failed.append(first_ts.astimezone(UTC).date())  # 首个封存日之前被补插记录
    expected_day, expected_prev = None, GENESIS
    for seal in seals:
        digest, _ = await _digest(conn, seal.day, seal.prev_hash)
        linked = seal.prev_hash == expected_prev and expected_day in (None, seal.day)
        if not linked or digest != seal.hash:
            failed.append(seal.day)
        expected_day, expected_prev = seal.day + DAY, seal.hash
    return failed
