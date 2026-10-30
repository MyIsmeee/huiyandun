"""带超时的 NATS 客户端（CD-04），对真实 nats-server 运行。"""

import asyncio
import logging
import time
import uuid
from collections.abc import Callable
from datetime import UTC, datetime, timedelta

import nats
import pytest
from nats.js.client import JetStreamContext

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
        object_class="person",
        x=1.0,
        y=2.0,
        uncertainty_m=0.1,
        heading_deg=None,
        speed_mps=None,
        bbox=[0.1, 0.2, 0.3, 0.8],
        keypoints=None,
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


def test_js_subscribe_replays_since_then_follows(nats_url: str) -> None:
    """重启恢复：返回时 since 之后的历史消息已全部交给 handler，之后的新消息继续投递。"""

    async def main() -> tuple[list[int], list[int]]:
        bus = await Bus.connect(nats_url, name="test", timeout_s=2)
        await bus.ensure_stream("REPLAY", ["hyd.test.replay"], 60)
        try:
            await bus.js_publish("hyd.test.replay", track(1))  # since 之前，不投递
            await asyncio.sleep(0.5)
            since = datetime.now(UTC)
            for i in (2, 3):
                await bus.js_publish("hyd.test.replay", track(i))
            received: list[int] = []

            async def handler(event: VisionTrackV1) -> None:
                received.append(event.track_id)

            await bus.js_subscribe("hyd.test.replay", VisionTrackV1, handler, since)
            history = list(received)
            await bus.js_publish("hyd.test.replay", track(4))
            for _ in range(50):
                if len(received) == 3:
                    break
                await asyncio.sleep(0.05)
            return history, received
        finally:
            await bus.close()

    assert asyncio.run(main()) == ([2, 3], [2, 3, 4])


def test_js_subscribe_without_history_returns_at_once(nats_url: str) -> None:
    """同一流的其他主题有消息、本主题没有时同样立即返回（如 HYD_VISION 只有画面事件、没有行为事件）。"""

    async def main() -> float:
        bus = await Bus.connect(nats_url, name="test", timeout_s=2)
        await bus.ensure_stream("EMPTY", ["hyd.test.empty", "hyd.test.other"], 60)
        try:
            await bus.js_publish("hyd.test.other", track())

            async def handler(event: VisionTrackV1) -> None:
                pass

            started = time.monotonic()
            since = datetime.now(UTC) - timedelta(minutes=1)
            await bus.js_subscribe("hyd.test.empty", VisionTrackV1, handler, since)
            return time.monotonic() - started
        finally:
            await bus.close()

    assert asyncio.run(main()) < 1


def test_js_subscribe_unsubscribes_when_setup_fails(
    nats_url: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """订阅建立后查询消费者状态失败：先退订再报错，重试不会留下重复订阅。"""

    async def fail(self: object) -> None:
        raise TimeoutError

    monkeypatch.setattr(JetStreamContext.PushSubscription, "consumer_info", fail)

    async def main() -> list[int]:
        bus = await Bus.connect(nats_url, name="test", timeout_s=2)
        await bus.ensure_stream("UNSUB", ["hyd.test.unsub"], 60)
        received: list[int] = []

        async def handler(event: VisionTrackV1) -> None:
            received.append(event.track_id)

        try:
            with pytest.raises(TimeoutError):
                await bus.js_subscribe("hyd.test.unsub", VisionTrackV1, handler, datetime.now(UTC))
            await bus.js_publish("hyd.test.unsub", track(7))
            await asyncio.sleep(0.5)
            return received
        finally:
            await bus.close()

    assert asyncio.run(main()) == []


def test_ensure_stream_is_idempotent_and_persists(nats_url: str) -> None:
    async def main() -> tuple[int, float, str]:
        bus = await Bus.connect(nats_url, name="test", timeout_s=2)
        raw = await nats.connect(nats_url)
        js = raw.jetstream()
        try:
            await bus.ensure_stream("ENSURE", ["hyd.test.ensure"], max_age_s=60)
            await bus.ensure_stream("ENSURE", ["hyd.test.ensure"], max_age_s=60)  # 再次启动
            await bus.js_publish("hyd.test.ensure", track())
            info = await js.stream_info("ENSURE")
            return info.state.messages, info.config.max_age, info.config.storage
        finally:
            await js.delete_stream("ENSURE")
            await raw.close()
            await bus.close()

    assert asyncio.run(main()) == (1, 60, "file")


def test_ensure_stream_updates_changed_config_and_keeps_messages(nats_url: str) -> None:
    """调整保留期、增加主题后重启：按新配置更新，不因与数据卷中的旧配置不同而无法启动。"""

    async def main() -> tuple[int, float, list[str]]:
        bus = await Bus.connect(nats_url, name="test", timeout_s=2)
        raw = await nats.connect(nats_url)
        js = raw.jetstream()
        try:
            await bus.ensure_stream("CHANGE", ["hyd.test.a"], max_age_s=60)
            await bus.js_publish("hyd.test.a", track())
            await bus.ensure_stream("CHANGE", ["hyd.test.a", "hyd.test.b"], max_age_s=120)
            info = await js.stream_info("CHANGE")
            return info.state.messages, info.config.max_age, info.config.subjects
        finally:
            await js.delete_stream("CHANGE")
            await raw.close()
            await bus.close()

    assert asyncio.run(main()) == (1, 120, ["hyd.test.a", "hyd.test.b"])


def test_js_publish_without_stream_rejected(nats_url: str) -> None:
    async def main() -> None:
        bus = await Bus.connect(nats_url, name="test", timeout_s=1)
        try:
            await bus.js_publish("hyd.test.nostream", track())
        finally:
            await bus.close()

    with pytest.raises(nats.js.errors.NoStreamResponseError):
        asyncio.run(main())


def test_handler_failure_logged_with_subject(
    nats_url: str, caplog: pytest.LogCaptureFixture
) -> None:
    async def main() -> VisionTrackV1:
        bus = await Bus.connect(nats_url, name="test", timeout_s=2)
        received: asyncio.Queue[VisionTrackV1] = asyncio.Queue()

        async def handler(event: VisionTrackV1) -> None:
            if event.track_id == 1:
                raise RuntimeError("boom")
            await received.put(event)

        await bus.subscribe(SUBJECT, VisionTrackV1, handler)
        await bus.publish(SUBJECT, track(1))
        await bus.publish(SUBJECT, track(2))
        try:
            return await asyncio.wait_for(received.get(), 2)
        finally:
            await bus.close()

    with caplog.at_level(logging.ERROR):
        assert asyncio.run(main()).track_id == 2  # 订阅不因 handler 异常中断
    [record] = [r for r in caplog.records if r.getMessage() == "bus.handler_failed"]
    assert record.subject == SUBJECT
    assert record.exc_info


def test_disconnected_publish_times_out_and_close_succeeds(
    disposable_nats: tuple[str, Callable[[], None]], caplog: pytest.LogCaptureFixture
) -> None:
    url, stop = disposable_nats

    async def main() -> Bus:
        bus = await Bus.connect(url, name="test", timeout_s=1)
        stop()
        await asyncio.sleep(2.5)  # 容器被强制删除，连接立即断开；等待至少一次重连失败
        start = time.monotonic()
        with pytest.raises(nats.errors.TimeoutError):
            await bus.js_publish("hyd.test.down", track())
        assert time.monotonic() - start < 2
        await bus.close()
        return bus

    with caplog.at_level(logging.DEBUG, logger="py_common.bus"):
        bus = asyncio.run(main())
    assert bus._client.is_closed  # 不再后台重连
    messages = [(r.levelno, r.getMessage()) for r in caplog.records]
    assert (logging.WARNING, "bus.disconnected") in messages
    assert not [m for m in messages if m[0] >= logging.ERROR]  # 断线重试不刷 ERROR


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
