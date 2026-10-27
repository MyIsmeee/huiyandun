import asyncio

from alembic import context
from sqlalchemy import Connection

from api_server.db import create_engine


def run(connection: Connection) -> None:
    context.configure(connection=connection)
    with context.begin_transaction():
        context.run_migrations()


async def main() -> None:
    engine = create_engine(context.config.attributes["config"])
    try:
        async with engine.connect() as connection:
            await connection.run_sync(run)
            await connection.commit()
    finally:
        await engine.dispose()


asyncio.run(main())
