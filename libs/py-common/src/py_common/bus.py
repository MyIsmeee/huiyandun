"""带超时的 NATS 客户端（CD-04），消息体为 contracts/events 生成的事件模型。

- publish：核心 NATS，写入发送缓冲即返回，用于不持久化的高频事件（如 track）；
- js_publish：JetStream，等待服务端确认；以 event_id 去重，重试不会产生重复消息；
- subscribe：消息按模型校验；非法消息与 handler 异常记录错误后跳过，不中断订阅。
"""

import asyncio
import logging
from collections.abc import Awaitable, Callable
from typing import Self

from nats import errors
from nats.aio.client import Client
from nats.aio.msg import Msg
from pydantic import ValidationError

from py_contracts.events.event_base_schema import EventBase

log = logging.getLogger(__name__)
# 导致断连的错误：nats-py 先报告错误、随后才切换为重连状态
CONNECTION_LOST = (errors.UnexpectedEOF, errors.StaleConnectionError, OSError)


class Bus:
    def __init__(self, client: Client, timeout_s: float) -> None:
        self._client = client
        self._js = client.jetstream(timeout=timeout_s)
        self._timeout_s = timeout_s

    @classmethod
    async def connect(cls, url: str, *, name: str, timeout_s: float) -> Self:
        client = Client()

        async def on_error(e: Exception) -> None:
            # 断连本身及断线期间的逐次重连失败已由 bus.disconnected 告警，不重复刷 ERROR
            if not client.is_connected or isinstance(e, CONNECTION_LOST):
                log.debug("bus.connection_error", extra={"error": repr(e)})
            else:
                log.error("bus.error", exc_info=e)

        async def on_disconnected() -> None:
            if not client.is_closed:  # 主动关闭同样触发此回调
                log.warning("bus.disconnected")

        async def on_reconnected() -> None:
            log.info("bus.reconnected")

        try:
            # nats-py 的重连参数同样作用于首次建连，须由外层限定总时长
            await asyncio.wait_for(
                client.connect(
                    url,
                    name=name,
                    connect_timeout=timeout_s,
                    drain_timeout=timeout_s,
                    # 建连后断线持续重连；断线期间 js_publish 按超时报错
                    max_reconnect_attempts=-1,
                    error_cb=on_error,
                    disconnected_cb=on_disconnected,
                    reconnected_cb=on_reconnected,
                ),
                timeout_s,
            )
        except TimeoutError:
            await client.close()
            raise
        return cls(client, timeout_s)

    async def publish(self, subject: str, event: EventBase) -> None:
        await self._client.publish(subject, event.model_dump_json().encode())

    async def js_publish(self, subject: str, event: EventBase) -> None:
        await self._js.publish(
            subject,
            event.model_dump_json().encode(),
            timeout=self._timeout_s,
            headers={"Nats-Msg-Id": str(event.event_id)},
        )

    async def subscribe[T: EventBase](
        self, subject: str, model: type[T], handler: Callable[[T], Awaitable[None]]
    ) -> None:
        async def on_message(msg: Msg) -> None:
            try:
                event = model.model_validate_json(msg.data)
            except ValidationError as e:
                log.error("bus.invalid_payload", extra={"subject": msg.subject, "error": str(e)})
                return
            try:
                await handler(event)
            except Exception:
                # 单条消息处理失败不中断订阅；记录主题以便定位
                log.exception("bus.handler_failed", extra={"subject": msg.subject})

        await self._client.subscribe(subject, cb=on_message)
        await self._client.flush(timeout=self._timeout_s)

    async def close(self) -> None:
        if self._client.is_connected:
            await self._client.drain()
            return
        # 断线期间 drain 会直接抛错且不停止后台重连，只能直接关闭。缓冲中未发出的数据已无法
        # 送达（js_publish 调用方已收到超时），先丢弃：nats-py 2.16 关闭时会把它写入已失效的
        # 连接而抛 TypeError；升级 nats-py 时由 test_disconnected_* 验证此处仍然成立
        self._client._pending.clear()
        self._client._pending_data_size = 0
        await self._client.close()
