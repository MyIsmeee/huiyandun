"""配置项（CD-05）。"""

from pathlib import Path

from pydantic import Field

from py_common.config import ServiceConfig


class DbConfig(ServiceConfig):
    """连接业务库的服务共用的配置项；表结构由 api-server 的迁移定义。"""

    db_host: str = Field("postgres", description="PostgreSQL 主机")
    db_port: int = Field(5432, ge=1, le=65535, description="PostgreSQL 端口")
    db_name: str = Field("hyd", description="数据库名")
    db_user: str = Field(
        "hyd_app", description="数据库账号：服务以非属主账号连接，迁移以属主账号执行（G-13）"
    )
    db_password_file: Path = Field(
        Path("/run/secrets/db_app_password"),
        description="数据库口令文件，口令不进入环境变量（G-14）",
    )
    db_timeout_s: float = Field(
        5.0, gt=0, le=60, description="数据库建连、取连接与单条语句的超时，单位秒（CD-04）"
    )


class ApiConfig(DbConfig):
    port: int = Field(8000, ge=1, le=65535, description="HTTP 监听端口")
    session_ttl_s: int = Field(
        28800, ge=300, le=86400, description="会话有效期，单位秒；到期须重新登录（C-BE-07）"
    )
