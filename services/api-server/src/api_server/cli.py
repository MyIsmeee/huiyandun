"""命令行入口 hyd-api：serve 启动服务；migrate 以属主账号执行数据库迁移。"""

import argparse

import uvicorn
from alembic import command

from api_server.app import create_app
from api_server.config import ApiConfig
from api_server.db import alembic_config
from py_common.config import load_config
from py_common.log import configure_logging


def main() -> None:
    parser = argparse.ArgumentParser(prog="hyd-api")
    parser.add_argument("command", choices=["serve", "migrate"])
    args = parser.parse_args()

    config = load_config(ApiConfig)
    configure_logging("api-server", config.log_level)
    if args.command == "migrate":
        command.upgrade(alembic_config(config), "head")
    else:
        # log_config=None：uvicorn 的日志沿用根 logger 的 JSON 格式（CD-06）
        uvicorn.run(create_app(config), host="0.0.0.0", port=config.port, log_config=None)
