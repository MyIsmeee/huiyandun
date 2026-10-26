"""WS /ws 推送框架：握手鉴权、广播、登出 / 过期 / 消费过慢时断开（FR-102、C-BE-07）。"""

import asyncio
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text
from starlette.websockets import WebSocketDisconnect

from api_server.app import create_app
from api_server.config import ApiConfig
from api_server.db import transaction
from api_server.ws import QUEUE_SIZE
from py_contracts.api import WsFrame

WS_URL = "wss://testserver/ws"  # Secure Cookie 只随加密连接发送
FRAME = WsFrame(channel="system", data={"llm": "template"})


@pytest.fixture
def client(db: tuple[ApiConfig, ApiConfig], password: str) -> Iterator[TestClient]:
    with TestClient(create_app(db[1]), base_url="https://testserver") as c:
        body = {"username": "viewer", "password": password}
        c.post("/api/auth/login", json=body, headers={"X-Request-ID": "r"})
        yield c


def broadcast(client: TestClient, frame: WsFrame, times: int = 1) -> None:
    """在应用的事件循环中广播：Hub 不是线程安全的。"""

    def run() -> None:
        for _ in range(times):
            client.app.state.hub.broadcast(frame)

    client.portal.call(run)


def test_rejects_handshake_without_session(client: TestClient) -> None:
    client.cookies.clear()

    with pytest.raises(WebSocketDisconnect) as exc, client.websocket_connect(WS_URL):
        pass
    assert exc.value.code == 1008


def test_pushes_contract_frames(client: TestClient) -> None:
    with client.websocket_connect(WS_URL) as ws:
        broadcast(client, FRAME)

        assert WsFrame.model_validate(ws.receive_json()) == FRAME


def test_logout_closes_connection(client: TestClient) -> None:
    with client.websocket_connect(WS_URL) as ws:
        client.post("/api/auth/logout", headers={"X-Request-ID": "r"})

        with pytest.raises(WebSocketDisconnect) as exc:
            ws.receive_json()
    assert exc.value.code == 1008


def test_slow_consumer_is_disconnected(client: TestClient) -> None:
    with client.websocket_connect(WS_URL) as ws:
        broadcast(client, FRAME, times=QUEUE_SIZE + 1)

        with pytest.raises(WebSocketDisconnect) as exc:
            while True:
                ws.receive_json()
    assert exc.value.code == 1013


def test_session_expiry_closes_connection(
    client: TestClient, db: tuple[ApiConfig, ApiConfig]
) -> None:
    async def expire_soon() -> None:
        async with transaction(db[0]) as conn:
            await conn.execute(text("UPDATE sessions SET expires_at = now() + interval '1 second'"))

    asyncio.run(expire_soon())
    with client.websocket_connect(WS_URL) as ws, pytest.raises(WebSocketDisconnect) as exc:
        ws.receive_json()
    assert exc.value.code == 1008
