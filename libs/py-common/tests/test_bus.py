"""带超时的 NATS 客户端（CD-04），对真实 nats-server 运行。"""

import asyncio
import logging
import time
import uuid
from datetime import UTC, datetime

import nats
import pytest

from py_common.bus import Bus
from py_contracts.events.hyd_vision_track_v1_schema import VisionTrackV1

SUBJECT = "hyd.vision.track.v1"


def track(track_id: int = 1) -> VisionTrackV1:
    return VisionTrackV1(
        schema_version="1.0.0",
        event_id=uuid.uuid4(),
        ts=datetime.now(UTC),
        camera_id="cam-01",
        track_id=track_id,
        x=1.0,
        y=2.0,
        uncertainty_m=0.1,
    )


def test_publish_subscribe_roundtrip(nats_url: str) -> None:
    async def main() -> VisionTrackV1:
        bus = await Bus.connect(nats_url, name="test", timeout_s=2)
        received: asyncio.Queue[VisionTrackV1] = asyncio.Queue()
        await bus.subscribe(SUBJECT, VisionTrackV1, received.put)
        await bus.publish(SUBJECT, sent)
        try:
            return await asyncio.wait_for(received.get(), 2)
        finally:
            await bus.close()

    sent = track()
    assert asyncio.run(main()) == sent


def test_subscribe_drops_invalid_payload(nats_url: str, caplog: pytest.LogCaptureFixture) -> None:
    async def main() -> list[VisionTrackV1]:
        bus = await Bus.connect(nats_url, name="test", timeout_s=2)
        received: asyncio.Queue[VisionTrackV1] = asyncio.Queue()
        await bus.subscribe(SUBJECT, VisionTrackV1, received.put)
        raw = await nats.connect(nats_url)
        await raw.publish(SUBJECT, b'{"camera_id": 1}')
        await raw.flush()
        await raw.close()
        await bus.publish(SUBJECT, valid)
        try:
            got = [await asyncio.wait_for(received.get(), 2)]
            await asyncio.sleep(0.2)
            return got + [received.get_nowait() for _ in range(received.qsize())]
        finally:
            await bus.close()

    valid = track(2)
    with caplog.at_level(logging.ERROR):
        assert asyncio.run(main()) == [valid]
    assert any(r.getMessage() == "bus.invalid_payload" for r in caplog.records)


def test_js_publish_deduplicates_by_event_id(nats_url: str) -> None:
    async def main() -> int:
        bus = await Bus.connect(nats_url, name="test", timeout_s=2)
        raw = await nats.connect(nats_url)
        js = raw.jetstream()
        await js.add_stream(name="DEDUP", subjects=["hyd.test.dedup"])
        try:
            event = track()
            await bus.js_publish("hyd.test.dedup", event)
            await bus.js_publish("hyd.test.dedup", event)  # 重试同一事件
            return (await js.stream_info("DEDUP")).state.messages
        finally:
            await js.delete_stream("DEDUP")
            await raw.close()
            await bus.close()

    assert asyncio.run(main()) == 1


def test_js_publish_without_stream_fails_within_timeout(nats_url: str) -> None:
    async def main() -> None:
        bus = await Bus.connect(nats_url, name="test", timeout_s=1)
        try:
            await bus.js_publish("hyd.test.nostream", track())
        finally:
            await bus.close()

    start = time.monotonic()
    with pytest.raises(nats.errors.Error):
        asyncio.run(main())
    assert time.monotonic() - start < 3


@pytest.mark.parametrize(
    "url",
    [
        "nats://10.255.255.1:4222",  # 不可路由：连接挂起
        "nats://127.0.0.1:1",  # 端口拒绝：如 NATS 尚未启动，nats-py 会反复重试
    ],
)
def test_connect_unreachable_fails_within_timeout(url: str) -> None:
    start = time.monotonic()
    with pytest.raises(TimeoutError):
        asyncio.run(Bus.connect(url, name="test", timeout_s=1))
    assert time.monotonic() - start < 5
