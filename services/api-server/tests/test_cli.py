"""hyd-api：migrate 只从 HYD_* 环境变量读取配置（CD-05），可重复执行；serve 拒绝非法 site.yaml。"""

import os
import subprocess
from pathlib import Path

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


def test_serve_refuses_invalid_site(tmp_path: Path) -> None:
    """site.yaml 不符合 Schema 时拒绝启动，并指出字段路径（FR-903）。"""
    site = tmp_path / "site.yaml"
    site.write_text("site: {id: x, name: x, width_m: 0, height_m: 24, mode: bypass}\n")
    env = os.environ | {"HYD_SITE_FILE": str(site)}

    result = subprocess.run(
        ["hyd-api", "serve"], env=env, capture_output=True, text=True, timeout=60
    )

    assert result.returncode == 1
    assert "site.width_m:" in result.stderr
    assert "walls: Field required" in result.stderr
