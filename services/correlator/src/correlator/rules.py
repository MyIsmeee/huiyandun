"""关联规则（HYD-PLAN-007 §4）：rules/correlator/<规则 ID>.yaml，启动时全部加载并校验。"""

from pathlib import Path
from typing import Annotated, Literal

import yaml
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from py_contracts.events.hyd_security_alert_v1_schema import SecurityAlertV1
from py_contracts.events.hyd_vision_behavior_v1_schema import VisionBehaviorV1
from py_contracts.events.hyd_vision_integrity_v1_schema import VisionIntegrityV1

type Event = SecurityAlertV1 | VisionIntegrityV1 | VisionBehaviorV1
# 规则可引用的事件主题
MODELS: dict[str, type[Event]] = {
    "hyd.security.alert.v1": SecurityAlertV1,
    "hyd.vision.integrity.v1": VisionIntegrityV1,
    "hyd.vision.behavior.v1": VisionBehaviorV1,
}

type Subject = Literal["hyd.security.alert.v1", "hyd.vision.integrity.v1", "hyd.vision.behavior.v1"]


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class Step(_Strict):
    subject: Subject
    # 只支持等值与"属于列表"两种比较（§4）
    match: dict[str, str | list[str]] = {}

    @model_validator(mode="after")
    def _fields_exist(self) -> "Step":
        unknown = set(self.match) - set(MODELS[self.subject].model_fields)
        if unknown:
            raise ValueError(f"{self.subject} 没有字段 {sorted(unknown)}")
        return self


class Emit(_Strict):
    severity: Literal["critical", "high", "medium", "low"]
    title: str
    techniques: list[Annotated[str, Field(pattern=r"^T[0-9]{4}([.][0-9]{3})?$")]]


class Rule(_Strict):
    id: Annotated[str, Field(pattern=r"^HYD-(NET|VIS|X)-[0-9]{4}$")]
    version: Annotated[str, Field(pattern=r"^[0-9]+\.[0-9]+\.[0-9]+$")]
    name: str
    mode: Literal["monitor", "enforce"]
    window_s: Annotated[int, Field(gt=0, le=86400)]
    # 关联键：告警取 device_id，视觉事件取 camera_id（摄像头 ID 即设备 ID）
    group_by: Literal["device_id"]
    sequence: Annotated[list[Step], Field(min_length=1)]
    emit: Emit


def load_rules(directory: Path) -> list[Rule]:
    """加载目录下全部规则；文件名须为规则 ID。任一非法即抛 ValueError，指出文件与字段。"""
    rules = []
    for path in sorted(directory.glob("*.yaml")):
        try:
            rule = Rule.model_validate(yaml.safe_load(path.read_text(encoding="utf-8")))
        except ValidationError as e:
            raise ValueError(f"{path}: {e}") from e
        if rule.id != path.stem:
            raise ValueError(f"{path}: 文件名须为规则 ID {rule.id}")
        rules.append(rule)
    return rules
