"""结构化日志（CD-06）：每条记录输出一行 JSON，固定字段 ts level service request_id event。

event 即日志消息，使用稳定的"模块.动作"名称（如 user.login）；附加字段经 extra= 传入。
"""

import json
import logging
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import UTC, datetime
from typing import TextIO

_request_id: ContextVar[str | None] = ContextVar("request_id", default=None)
# LogRecord 自带的属性不作为附加字段输出
_RESERVED = frozenset(vars(logging.makeLogRecord({}))) | {"message", "asctime"}


@contextmanager
def bind_request_id(request_id: str) -> Iterator[None]:
    """在当前上下文及其中创建的 asyncio 任务内，为日志附加 request_id（C-BE-08）。"""
    token = _request_id.set(request_id)
    try:
        yield
    finally:
        _request_id.reset(token)


class _JsonFormatter(logging.Formatter):
    def __init__(self, service: str) -> None:
        super().__init__()
        self._service = service

    def format(self, record: logging.LogRecord) -> str:
        ts = datetime.fromtimestamp(record.created, UTC).isoformat(timespec="milliseconds")
        entry = {
            "ts": ts.replace("+00:00", "Z"),
            "level": record.levelname,
            "service": self._service,
            "request_id": _request_id.get(),
            "event": record.getMessage(),
        }
        for key, value in vars(record).items():
            if key not in _RESERVED and key not in entry:
                entry[key] = value
        if record.exc_info:
            entry["exc"] = self.formatException(record.exc_info)
        return json.dumps(entry, ensure_ascii=False, default=str)


def configure_logging(service: str, level: str, stream: TextIO | None = None) -> None:
    """进程启动时调用一次；替换根 logger 的处理器，第三方库的日志同样输出为 JSON。

    stream 默认为 stderr。
    """
    handler = logging.StreamHandler(stream)
    handler.setFormatter(_JsonFormatter(service))
    logging.basicConfig(level=level, handlers=[handler], force=True)
