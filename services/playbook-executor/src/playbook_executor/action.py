"""处置动作接口（HYD-PLAN-007 §5、C-BE-03）：每个动作实现 precheck / execute / verify / rollback，缺一不得注册。"""

from dataclasses import dataclass
from ipaddress import IPv4Address, IPv6Address
from typing import Any, Protocol


@dataclass(frozen=True)
class ActionContext:
    """处置参数只取关联事件的结构化字段（G-03、C-SEC-02）。"""

    target: IPv4Address | IPv6Address
    ttl_s: int
    params: dict[str, Any]


class ActionError(RuntimeError):
    """动作执行失败：原因写入执行记录（FR-406）。"""


@dataclass(frozen=True)
class Result:
    passed: bool
    reason: str | None = None


class Action(Protocol):
    async def precheck(self, ctx: ActionContext) -> Result: ...

    async def execute(self, ctx: ActionContext) -> None: ...

    async def verify(self, ctx: ActionContext) -> Result: ...  # 检查真实效果（DP-10）

    async def rollback(self, ctx: ActionContext) -> None: ...

    async def intercepted(self, ctx: ActionContext) -> int | None:
        """生效后的拦截证据（D-072）：已拦截的数据包数，规则已不在时为 None。"""
        ...
