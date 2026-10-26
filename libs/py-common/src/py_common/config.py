"""配置 Schema（CD-05）：配置项声明类型、默认值、范围、说明，只读取已声明的环境变量。

服务继承 ServiceConfig 声明自己的配置项，启动时调用 load_config。字段 foo_bar 对应环境变量
HYD_FOO_BAR；未声明的 HYD_* 变量与非法值在启动时报错，不静默忽略。
"""

import os
from collections.abc import Mapping
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

PREFIX = "HYD_"


class ServiceConfig(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR"] = Field("INFO", description="日志级别")
    nats_url: str = Field("nats://nats:4222", description="NATS 地址")
    nats_timeout_s: float = Field(
        2.0, gt=0, le=30, description="NATS 每次网络操作的超时，单位秒（CD-04）"
    )

    @classmethod
    def __pydantic_init_subclass__(cls, **kwargs: Any) -> None:
        super().__pydantic_init_subclass__(**kwargs)
        undocumented = [name for name, field in cls.model_fields.items() if not field.description]
        if undocumented:
            raise TypeError(f"配置项缺少说明（CD-05）：{', '.join(undocumented)}")


def load_config[T: ServiceConfig](model: type[T], environ: Mapping[str, str] = os.environ) -> T:
    values = {
        key.removeprefix(PREFIX).lower(): value
        for key, value in environ.items()
        if key.startswith(PREFIX)
    }
    return model.model_validate(values)
