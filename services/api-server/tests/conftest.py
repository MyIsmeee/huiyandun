"""api-server 用例的账户与 WS 连接夹具；数据库夹具 db 见仓库根目录 conftest.py。"""

import asyncio
from collections.abc import Callable, Iterator
from contextlib import AbstractContextManager, contextmanager

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import insert
from starlette.testclient import WebSocketTestSession

from api_server.auth import ROLES, hash_password, users
from api_server.config import ApiConfig
from api_server.db import transaction
from py_contracts.api import WsFrame

PASSWORD = "correct-horse-1"
WS_URL = "wss://testserver/ws"  # Secure Cookie 只随加密连接发送
DRAINED = WsFrame(channel="system", data={"type": "drained"})


@pytest.fixture(scope="session")
def password(db: tuple[ApiConfig, ApiConfig]) -> str:
    """每种角色一个账户，用户名即角色名；返回共用口令。"""

    async def main() -> None:
        async with transaction(db[1]) as conn:
            await conn.execute(
                insert(users),
                [
                    {"username": r, "password_hash": hash_password(PASSWORD), "role": r}
                    for r in ROLES
                ],
            )

    asyncio.run(main())
    return PASSWORD


@pytest.fixture
def ws_connect(client: TestClient) -> Callable[[], AbstractContextManager[WebSocketTestSession]]:
    """连接 /ws 并读过连接建立时补推的全部帧（设备、场景、近 24 小时历史），用例从其后的帧开始断言；
    client 为用例所在文件的夹具。"""

    @contextmanager
    def connect() -> Iterator[WebSocketTestSession]:
        with client.websocket_connect(WS_URL) as ws:
            assert ws.receive_json()["channel"] == "devices"  # 补推已开始
            # 广播一帧标记：排在补推之后，读到它即读完补推
            client.app.state.hub.broadcast(DRAINED)
            while ws.receive_json() != DRAINED.model_dump(mode="json"):
                pass
            yield ws

    return connect
