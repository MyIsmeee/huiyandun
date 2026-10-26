"""以 compose.yaml 锁定的镜像启动临时 NATS，测试结束即删除。"""

import socket
import subprocess
import time
from collections.abc import Iterator
from pathlib import Path

import pytest
import yaml

COMPOSE = Path(__file__).resolve().parents[3] / "deploy/compose/compose.yaml"


def docker(*args: str) -> str:
    return subprocess.run(
        ["docker", *args], capture_output=True, text=True, timeout=120, check=True
    ).stdout.strip()


@pytest.fixture(scope="session")
def nats_url() -> Iterator[str]:
    image = yaml.safe_load(COMPOSE.read_text(encoding="utf-8"))["services"]["nats"]["image"]
    container = docker("run", "-d", "--rm", "-p", "127.0.0.1::4222", image, "nats-server", "-js")
    try:
        host, port = docker("port", container, "4222").splitlines()[0].rsplit(":", 1)
        deadline = time.monotonic() + 10
        while True:
            try:
                socket.create_connection((host, int(port)), timeout=1).close()
                break
            except OSError:
                if time.monotonic() > deadline:
                    raise
                time.sleep(0.1)
        yield f"nats://{host}:{port}"
    finally:
        docker("rm", "-f", container)
