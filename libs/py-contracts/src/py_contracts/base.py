"""生成模型的公共基类（pyproject.toml 的 base-class）。

JSON Schema 无法表达以下约束，在此统一校验：
- 数值必须有限：NaN / inf 序列化为 JSON 时变成 null，消费方校验会失败；
- 时间必须为 UTC（HYD-PLAN-007 §1、CD-07）：date-time 上的 pattern 会被代码生成忽略。
"""

from datetime import datetime, timedelta

from pydantic import BaseModel, ConfigDict, field_validator


class ContractModel(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False)

    @field_validator("*")
    @classmethod
    def _require_utc(cls, value: object) -> object:
        if isinstance(value, datetime) and value.utcoffset() != timedelta(0):
            raise ValueError("时间必须为 UTC")
        return value
