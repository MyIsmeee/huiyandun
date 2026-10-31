"""scenario-runner 的观测端（TK-100）：订阅给定主题，每条消息以一行 JSON 写到标准输出。

在 core-net 内以 docker compose run 运行（compose 服务 scenario-runner）；标准输入关闭即退出，
编排脚本结束或中断时容器随之结束。
"""

import asyncio
import json
import sys

import nats
from nats.aio.msg import Msg

from py_common.config import ServiceConfig, load_config


def emit(line: dict[str, object]) -> None:
    sys.stdout.write(json.dumps(line, ensure_ascii=False) + "\n")
    sys.stdout.flush()


async def main(subjects: list[str]) -> None:
    config = load_config(ServiceConfig)
    nc = await nats.connect(config.nats_url, connect_timeout=config.nats_timeout_s)

    async def forward(msg: Msg) -> None:
        emit({"subject": msg.subject, "event": json.loads(msg.data)})

    for subject in subjects:
        await nc.subscribe(subject, cb=forward)
    await nc.flush(timeout=config.nats_timeout_s)
    emit({"ready": True})
    await asyncio.to_thread(sys.stdin.read)
    await nc.close()


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1:]))
