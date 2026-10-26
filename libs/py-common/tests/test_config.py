"""配置 Schema（CD-05）：只读取已声明的 HYD_* 环境变量，未声明或越界即失败。"""

import pytest
from pydantic import Field, ValidationError

from py_common.config import ServiceConfig, load_config


class DemoConfig(ServiceConfig):
    port: int = Field(8000, ge=1, le=65535, description="监听端口")


def test_defaults() -> None:
    config = load_config(DemoConfig, {})

    assert config.port == 8000
    assert config.log_level == "INFO"


def test_reads_declared_variables() -> None:
    config = load_config(DemoConfig, {"HYD_PORT": "9000", "HYD_LOG_LEVEL": "DEBUG"})

    assert config.port == 9000
    assert config.log_level == "DEBUG"


def test_ignores_variables_without_prefix() -> None:
    assert load_config(DemoConfig, {"PORT": "1", "PATH": "/bin"}).port == 8000


@pytest.mark.parametrize(
    ("environ", "field"),
    [
        ({"HYD_PROT": "9000"}, "prot"),  # 拼写错误不能被静默忽略
        ({"HYD_PORT": "70000"}, "port"),
        ({"HYD_LOG_LEVEL": "VERBOSE"}, "log_level"),
        ({"HYD_NATS_TIMEOUT_S": "0"}, "nats_timeout_s"),
    ],
)
def test_rejects_invalid(environ: dict[str, str], field: str) -> None:
    with pytest.raises(ValidationError, match=field):
        load_config(DemoConfig, environ)


def test_immutable() -> None:
    config = load_config(DemoConfig, {})

    with pytest.raises(ValidationError):
        config.port = 1


def test_every_field_requires_description() -> None:
    with pytest.raises(TypeError, match="undocumented"):

        class Undocumented(ServiceConfig):
            undocumented: int = 1
