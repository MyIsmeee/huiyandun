"""带超时的 NATS 客户端（CD-04），消息体为 contracts/events 生成的事件模型。

- publish：核心 NATS，写入发送缓冲即返回，用于不持久化的高频事件（如 track）；
- js_publish：JetStream，等待服务端确认；以 event_id 去重，重试不会产生重复消息；
- subscribe：消息按模型校验，非法消息记录错误后丢弃，不中断订阅。
"""

import asyncio
import logging
from collections.abc import Awaitable, Callable
from typing import Self

from nats.aio.client import Client
from nats.aio.msg import Msg
from pydantic import ValidationError

from py_contracts.events.event_base_schema import EventBase

log = logging.getLogger(__name__)


class Bus:
    def __init__(self, client: Client, timeout_s: float) -> None:
        self._client = client
        self._js = client.jetstream(timeout=timeout_s)
        self._timeout_s = timeout_s

    @classmethod
    async def connect(cls, url: str, *, name: str, timeout_s: float) -> Self:
        client = Client()
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
            await handler(event)

        await self._client.subscribe(subject, cb=on_message)
        await self._client.flush(timeout=self._timeout_s)

    async def close(self) -> None:
        await self._client.drain()
