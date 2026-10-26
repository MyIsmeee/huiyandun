"""hyd-api migrate 只从 HYD_* 环境变量读取配置（CD-05），可重复执行。"""

import os
import subprocess

from api_server.config import ApiConfig


def test_migrate_reads_config_from_environment(db: tuple[ApiConfig, ApiConfig]) -> None:
    owner = db[0]
    env = os.environ | {
        "HYD_DB_HOST": owner.db_host,
        "HYD_DB_PORT": str(owner.db_port),
        "HYD_DB_USER": owner.db_user,
        "HYD_DB_PASSWORD_FILE": str(owner.db_password_file),
    }

    result = subprocess.run(
        ["hyd-api", "migrate"], env=env, capture_output=True, text=True, timeout=60
    )

    assert result.returncode == 0, result.stderr
    assert owner.db_password_file.read_text() not in result.stderr
