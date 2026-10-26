"""结构化日志（CD-06）：每条记录一行 JSON，固定字段 ts level service request_id event。"""

import asyncio
import io
import json
import logging
import re

import pytest

from py_common.log import bind_request_id, configure_logging

TS = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")


@pytest.fixture
def stream() -> io.StringIO:
    buf = io.StringIO()
    configure_logging("api-server", "INFO", stream=buf)
    return buf


def records(buf: io.StringIO) -> list[dict]:
    return [json.loads(line) for line in buf.getvalue().splitlines()]


def test_fixed_fields(stream: io.StringIO) -> None:
    logging.getLogger("any").info("user.login")

    [record] = records(stream)
    assert record.keys() == {"ts", "level", "service", "request_id", "event"}
    assert TS.match(record["ts"])
    assert record["level"] == "INFO"
    assert record["service"] == "api-server"
    assert record["request_id"] is None
    assert record["event"] == "user.login"


def test_level_filter(stream: io.StringIO) -> None:
    logging.getLogger("any").debug("noise")

    assert records(stream) == []


def test_extra_fields(stream: io.StringIO) -> None:
    logging.getLogger("any").warning("login.failed", extra={"username": "bob", "attempt": 3})

    [record] = records(stream)
    assert record["username"] == "bob"
    assert record["attempt"] == 3


def test_exception_included(stream: io.StringIO) -> None:
    try:
        raise ValueError("boom")
    except ValueError:
        logging.getLogger("any").exception("task.failed")

    [record] = records(stream)
    assert record["level"] == "ERROR"
    assert "ValueError: boom" in record["exc"]


def test_request_id_isolated_between_tasks(stream: io.StringIO) -> None:
    async def handle(request_id: str) -> None:
        with bind_request_id(request_id):
            await asyncio.sleep(0)
            logging.getLogger("any").info("request.done")

    async def main() -> None:
        await asyncio.gather(handle("req-a"), handle("req-b"))

    asyncio.run(main())
    logging.getLogger("any").info("after")

    assert sorted(r["request_id"] for r in records(stream)[:2]) == ["req-a", "req-b"]
    assert records(stream)[2]["request_id"] is None
