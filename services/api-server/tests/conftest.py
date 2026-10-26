"""api-server 用例的账户夹具；数据库夹具 db 见仓库根目录 conftest.py。"""

import asyncio

import pytest
from sqlalchemy import insert

from api_server.auth import ROLES, hash_password, users
from api_server.config import ApiConfig
from api_server.db import transaction

PASSWORD = "correct-horse-1"


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
