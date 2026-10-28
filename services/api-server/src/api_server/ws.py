"""WebSocket 推送框架（FR-102、FR-606）：WS /ws 只向已登录客户端推送契约 WsFrame。

握手时以会话 Cookie 鉴权（SameSite=Strict，跨站页面发起的握手不携带 Cookie）；会话到期、
登出或客户端消费过慢时断开。连接建立时先补推设备状态快照，之后推送广播的帧。
"""

import asyncio
from dataclasses import dataclass, field
from datetime import UTC, datetime

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from api_server.auth import COOKIE, lookup_session
from py_contracts.api import WsFrame

QUEUE_SIZE = 256
POLICY_VIOLATION = 1008
TRY_AGAIN_LATER = 1013
# 空闲时前端据此区分"连接正常但无事件"与"数据已停止"：超过 2 个周期无帧即显示"延迟"
HEARTBEAT_S = 5
HEARTBEAT = WsFrame(channel="system", data={"type": "heartbeat"})


class _Stop(Exception):
    """连接任务之一正常结束（客户端断开或需服务端关闭），结束整个连接。"""


@dataclass(eq=False)
class Subscriber:
    token_hash: bytes
    queue: asyncio.Queue[str] = field(default_factory=lambda: asyncio.Queue(QUEUE_SIZE))
    closed: asyncio.Event = field(default_factory=asyncio.Event)
    close_code: int = POLICY_VIOLATION
    close_reason: str = ""

    def close(self, code: int, reason: str) -> None:
        if not self.closed.is_set():
            self.close_code, self.close_reason = code, reason
            self.closed.set()


class Hub:
    """进程内广播：每个连接一个有界队列，队列满即断开该连接，不拖慢其他连接。"""

    def __init__(self) -> None:
        self._subscribers: set[Subscriber] = set()

    def subscribe(self, token_hash: bytes) -> Subscriber:
        subscriber = Subscriber(token_hash)
        self._subscribers.add(subscriber)
        return subscriber

    def unsubscribe(self, subscriber: Subscriber) -> None:
        self._subscribers.discard(subscriber)

    def broadcast(self, frame: WsFrame) -> None:
        text = frame.model_dump_json()
        for subscriber in self._subscribers:
            try:
                subscriber.queue.put_nowait(text)
            except asyncio.QueueFull:
                subscriber.close(TRY_AGAIN_LATER, "消费过慢")

    def disconnect_session(self, token_hash: bytes) -> None:
        for subscriber in self._subscribers:
            if subscriber.token_hash == token_hash:
                subscriber.close(POLICY_VIOLATION, "已登出")


async def heartbeat(hub: Hub) -> None:
    while True:
        await asyncio.sleep(HEARTBEAT_S)
        hub.broadcast(HEARTBEAT)


router = APIRouter()


@router.websocket("/ws")
async def push(websocket: WebSocket) -> None:
    principal = await lookup_session(websocket.app.state.engine, websocket.cookies.get(COOKIE))
    if principal is None:
        await websocket.close(POLICY_VIOLATION, "未登录或会话失效")
        return
    await websocket.accept()
    hub: Hub = websocket.app.state.hub
    subscriber = hub.subscribe(principal.token_hash)
    # 先补推当前设备状态：断线期间错过的变化无从补齐
    for frame in websocket.app.state.devices.snapshot():
        subscriber.queue.put_nowait(frame.model_dump_json())

    async def send() -> None:
        while True:
            await websocket.send_text(await subscriber.queue.get())

    async def receive() -> None:
        # 只推送不接收；读取以便感知客户端断开
        while (await websocket.receive())["type"] != "websocket.disconnect":
            pass
        raise _Stop

    async def watch() -> None:
        await subscriber.closed.wait()
        raise _Stop

    remaining_s = (principal.expires_at - datetime.now(UTC)).total_seconds()
    try:
        try:
            # TaskGroup：任一任务结束即取消其余任务，外部取消（如服务停止）同样正确传播
            async with asyncio.timeout(remaining_s), asyncio.TaskGroup() as tg:
                for coro in (send(), receive(), watch()):
                    tg.create_task(coro)
        except* (_Stop, WebSocketDisconnect):
            pass  # 客户端断开时发送失败（WebSocketDisconnect）属正常结束
    except TimeoutError:
        subscriber.close(POLICY_VIOLATION, "会话已过期")
    finally:
        hub.unsubscribe(subscriber)
    if subscriber.closed.is_set():
        await websocket.close(subscriber.close_code, subscriber.close_reason)
