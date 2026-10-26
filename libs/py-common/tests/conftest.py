"""以 compose.yaml 锁定的镜像启动临时 NATS，测试结束即删除。"""

import asyncio
import subprocess
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path

import nats
import pytest
import yaml

COMPOSE = Path(__file__).resolve().parents[3] / "deploy/compose/compose.yaml"


def docker(*args: str, check: bool = True) -> str:
    return subprocess.run(
        ["docker", *args], capture_output=True, text=True, timeout=120, check=check
    ).stdout.strip()


async def wait_jetstream_ready(url: str, timeout_s: float = 10) -> None:
    """端口可连时 JetStream 可能尚未就绪，以 account_info 成功为准。"""
    async with asyncio.timeout(timeout_s):
        while True:
            try:
                client = await nats.connect(url, allow_reconnect=False, connect_timeout=1)
                try:
                    await client.jetstream().account_info()
                    return
                finally:
                    await client.close()
            except (OSError, nats.errors.Error):
                await asyncio.sleep(0.1)


@contextmanager
def nats_server() -> Iterator[tuple[str, Callable[[], None]]]:
    """返回地址与停止函数；停止后容器即删除。"""
    image = yaml.safe_load(COMPOSE.read_text(encoding="utf-8"))["services"]["nats"]["image"]
    container = docker("run", "-d", "--rm", "-p", "127.0.0.1::4222", image, "nats-server", "-js")
    try:
        host, port = docker("port", container, "4222").splitlines()[0].rsplit(":", 1)
        url = f"nats://{host}:{port}"
        asyncio.run(wait_jetstream_ready(url))
        yield url, lambda: docker("rm", "-f", container)
    finally:
        docker("rm", "-f", container, check=False)


@pytest.fixture(scope="session")
def nats_url() -> Iterator[str]:
    with nats_server() as (url, _):
        yield url


@pytest.fixture
def disposable_nats() -> Iterator[tuple[str, Callable[[], None]]]:
    """单个测试独占的 NATS，可在测试中途停止以模拟断线。"""
    with nats_server() as server:
        yield server
