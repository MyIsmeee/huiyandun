"""Playbook（HYD-PLAN-007 §5）：playbooks/<Playbook ID>.yaml，启动时全部加载并校验。"""

from pathlib import Path
from typing import Annotated, Any, Literal

import yaml
from pydantic import BaseModel, ConfigDict, Field, ValidationError


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class Trigger(_Strict):
    rule_ids: Annotated[list[str], Field(min_length=1)]  # 只引用规则引擎输出（C-SEC-02）
    severity: Annotated[list[Literal["critical", "high", "medium", "low"]], Field(min_length=1)]


class Step(_Strict):
    adapter: Literal["nftables"]
    action: Literal["block_ip"]
    params: dict[str, Any] = {}


class Playbook(_Strict):
    id: Annotated[str, Field(pattern=r"^[a-z0-9-]+$")]
    version: Annotated[str, Field(pattern=r"^[0-9]+\.[0-9]+\.[0-9]+$")]
    trigger: Trigger
    requires_mode: Annotated[list[Literal["bypass", "host_probe"]], Field(min_length=1)]
    target: Literal["incident.source_ip"]  # 只能引用 Incident 的结构化字段（G-03）
    ttl_s: Annotated[int, Field(ge=1, le=86400)] = 1800  # C-BE-05：默认 30 分钟，上限 24 小时
    actions: Annotated[list[Step], Field(min_length=1)]
    on_failure: Literal["rollback_and_notify"]


def load_playbooks(directory: Path) -> list[Playbook]:
    """加载目录下全部 Playbook；文件名须为 Playbook ID。任一非法即抛 ValueError，指出文件与字段。"""
    playbooks = []
    for path in sorted(directory.glob("*.yaml")):
        try:
            playbook = Playbook.model_validate(yaml.safe_load(path.read_text(encoding="utf-8")))
        except ValidationError as e:
            raise ValueError(f"{path}: {e}") from e
        if playbook.id != path.stem:
            raise ValueError(f"{path}: 文件名须为 Playbook ID {playbook.id}")
        playbooks.append(playbook)
    return playbooks
