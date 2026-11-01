"""AI 安全值班员的只读工具（TK-116、FR-1101）：数据取自内存历史、站点登记与设备状态、Zeek 会话日志、
ATT&CK 精简表。

参数以 Pydantic 校验，未声明的字段与未知工具一律拒绝、不执行；结果至多 MAX_ITEMS 条并附总数，不回显查询
参数（回溯依据只含查到的数据，FR-1103）。工具只读：不写库、不发事件（G-03）。
"""

import asyncio
import json
from collections import Counter
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Annotated, Any, Self

from pydantic import BaseModel, ConfigDict, Field, IPvAnyAddress, ValidationError, model_validator

from api_server.devices import Devices
from api_server.history import History
from py_contracts.events.event_base_schema import EventBase
from py_contracts.events.hyd_security_alert_v1_schema import SecurityAlertV1
from py_contracts.events.hyd_vision_behavior_v1_schema import VisionBehaviorV1
from py_contracts.events.hyd_vision_integrity_v1_schema import VisionIntegrityV1

MAX_ITEMS = 20
TIMEOUT_S = 2.0  # 单次工具执行的上限（借鉴 DeepSeek Harness）
TAIL_BYTES = 4 * 1024 * 1024  # conn.log 只读末尾，演示期间的会话足够覆盖 60 分钟
BEHAVIOR = {"fall": "跌倒", "climb": "攀爬"}
SOURCE = {"rule": "规则", "model": "模型"}


class _Args(BaseModel):
    model_config = ConfigDict(extra="forbid")


type Minutes = Annotated[int, Field(ge=1, le=60)]


class AlertsArgs(_Args):
    ip: IPvAnyAddress | None = None
    device_id: str | None = Field(None, max_length=64)
    minutes: Minutes = 10

    @model_validator(mode="after")
    def _one(self) -> Self:
        if (self.ip is None) == (self.device_id is None):
            raise ValueError("ip 与 device_id 须二选一")
        return self


class FrameArgs(_Args):
    camera_id: str = Field(max_length=64)
    minutes: Minutes = 10


class DeviceArgs(_Args):
    device_id: str = Field(max_length=64)


class SessionsArgs(_Args):
    ip: IPvAnyAddress
    minutes: Minutes = 10


class TechniqueArgs(_Args):
    technique_id: str = Field(pattern=r"^T\d{4}(\.\d{3})?$")


@dataclass
class ToolResult:
    args_summary: str  # 展示给值守人员
    data: dict[str, Any]  # 交给模型
    summary: str  # 展示给值守人员


def _alert_item(event: EventBase) -> dict[str, Any]:
    if isinstance(event, SecurityAlertV1):
        return {"kind": "security_alert", "ts": event.ts.isoformat()} | event.model_dump(
            mode="json",
            include={"category", "severity", "src_ip", "dst_ip", "device_id", "technique",
                     "source", "confidence", "summary"},
        )  # fmt: skip
    if isinstance(event, VisionBehaviorV1):
        return {"kind": "behavior", "ts": event.ts.isoformat()} | event.model_dump(
            mode="json", include={"camera_id", "behavior", "confidence_avg", "duration_s"}
        )
    assert isinstance(event, VisionIntegrityV1)
    return {"kind": "integrity", "ts": event.ts.isoformat()} | event.model_dump(
        mode="json", include={"camera_id", "type", "duration_s", "source", "confidence", "detail"}
    )


def _describe(item: dict[str, Any]) -> str:
    if item["kind"] == "security_alert":
        return f"{item['summary']}（{item['src_ip']} → {item['dst_ip']}）"
    if item["kind"] == "behavior":
        return BEHAVIOR[item["behavior"]]
    return f"{item['type']}（{SOURCE[item['source']]}，可信度 {item['confidence']:.2f}）"


def _listing(events: list[EventBase], minutes: int, noun: str) -> tuple[dict[str, Any], str]:
    items = [_alert_item(e) for e in sorted(events, key=lambda e: e.ts, reverse=True)]
    summary = f"近 {minutes} 分钟 {len(items)} 条{noun}"
    if items:
        summary += f"，最近：{_describe(items[0])}"
    return {"total": len(items), "items": items[:MAX_ITEMS]}, summary


def _since(minutes: int) -> datetime:
    return datetime.now(UTC) - timedelta(minutes=minutes)


def _read_conn_log(path: Path, since: float, ip: str) -> list[dict[str, Any]]:
    """Zeek JSON 日志（每行一条会话）中与 ip 相关、ts 不早于 since 的会话。"""
    with path.open("rb") as f:
        size = f.seek(0, 2)
        f.seek(max(0, size - TAIL_BYTES))
        lines = f.read().decode("utf-8", errors="replace").splitlines()
    if size > TAIL_BYTES:
        lines = lines[1:]  # 从中间读起的第一行不完整
    sessions = []
    for line in lines:
        try:
            s = json.loads(line)
        except ValueError:
            continue
        if s.get("ts", 0) >= since and ip in (s.get("id.orig_h"), s.get("id.resp_h")):
            sessions.append(s)
    return sessions


class Tools:
    def __init__(
        self, history: History, devices: Devices, conn_log: Path, techniques: dict[str, Any]
    ) -> None:
        self._history, self._devices = history, devices
        self._conn_log, self._techniques = conn_log, techniques
        self._tools: dict[
            str, tuple[type[_Args], Callable[[Any], Awaitable[tuple[dict[str, Any], str]]]]
        ] = {
            "list_alerts": (AlertsArgs, self._list_alerts),
            "list_frame_events": (FrameArgs, self._list_frame_events),
            "get_device": (DeviceArgs, self._get_device),
            "query_sessions": (SessionsArgs, self._query_sessions),
            "lookup_technique": (TechniqueArgs, self._lookup_technique),
        }

    async def run(self, tool: str, args: dict[str, Any]) -> ToolResult:
        raw = ", ".join(f"{k}={v}" for k, v in args.items())
        if tool not in self._tools:
            known = "、".join(self._tools)
            error = f"未知工具 {tool}，可用工具：{known}"
            return ToolResult(raw, {"error": error}, f"已拒绝：未知工具 {tool}")
        model, fn = self._tools[tool]
        try:
            parsed = model.model_validate(args)
        except ValidationError as e:
            error = "参数不合法：" + "；".join(err["msg"] for err in e.errors())
            return ToolResult(raw, {"error": error}, "已拒绝：参数不合法")
        shown = ", ".join(f"{k}={v}" for k, v in parsed.model_dump(exclude_none=True).items())
        try:
            async with asyncio.timeout(TIMEOUT_S):
                data, summary = await fn(parsed)
        except TimeoutError:
            return ToolResult(shown, {"error": f"查询超过 {TIMEOUT_S:g} 秒"}, "查询超时")
        return ToolResult(shown, data, summary)

    async def _list_alerts(self, a: AlertsArgs) -> tuple[dict[str, Any], str]:
        ip, device = str(a.ip) if a.ip else None, a.device_id

        def match(e: EventBase) -> bool:
            if isinstance(e, SecurityAlertV1):
                return ip in (str(e.src_ip), str(e.dst_ip)) or device == e.device_id
            return isinstance(e, VisionBehaviorV1) and device == e.camera_id

        events = [e for e in self._history.events_since(_since(a.minutes)) if match(e)]
        return _listing(events, a.minutes, "告警")

    async def _list_frame_events(self, a: FrameArgs) -> tuple[dict[str, Any], str]:
        events = [
            e
            for e in self._history.events_since(_since(a.minutes))
            if isinstance(e, VisionIntegrityV1 | VisionBehaviorV1) and e.camera_id == a.camera_id
        ]
        return _listing(events, a.minutes, "画面事件")

    async def _get_device(self, a: DeviceArgs) -> tuple[dict[str, Any], str]:
        device = self._devices.get(a.device_id)
        if device is None:
            return {"found": False}, f"未登记的设备 {a.device_id}"
        data = device.model_dump(
            mode="json", include={"id", "type", "ip", "mode", "state", "alert_severity"}
        )
        summary = f"{device.id}：{device.type} {device.ip}，状态 {device.state}"
        if device.alert_severity:
            summary += f"（{device.alert_severity}）"
        return data, summary

    async def _query_sessions(self, a: SessionsArgs) -> tuple[dict[str, Any], str]:
        if not self._conn_log.is_file():
            return {"available": False}, "会话日志不可用"
        ip = str(a.ip)
        since = _since(a.minutes).timestamp()
        sessions = await asyncio.to_thread(_read_conn_log, self._conn_log, since, ip)
        peers: dict[tuple[str, int, str], dict[str, Any]] = {}
        for s in sessions:
            outbound = s["id.orig_h"] == ip
            key = (s["id.resp_h"] if outbound else s["id.orig_h"], s["id.resp_p"],
                   "out" if outbound else "in")  # fmt: skip
            peer = peers.setdefault(key, {"count": 0, "bytes": 0, "states": Counter()})
            peer["count"] += 1
            peer["bytes"] += (s.get("orig_bytes") or 0) + (s.get("resp_bytes") or 0)
            peer["states"][s.get("conn_state", "-")] += 1
        ranked = sorted(peers.items(), key=lambda kv: kv[1]["count"], reverse=True)
        items = [
            {"peer": p, "port": port, "direction": d, "count": v["count"], "bytes": v["bytes"],
             "states": dict(v["states"])}
            for (p, port, d), v in ranked
        ]  # fmt: skip
        summary = f"近 {a.minutes} 分钟 {len(sessions)} 个会话，对端 {len(items)} 个"
        if items:
            summary += f"，最多：{items[0]['peer']}:{items[0]['port']} {items[0]['count']} 次"
        return {"available": True, "total": len(sessions), "peers": items[:MAX_ITEMS]}, summary

    async def _lookup_technique(self, a: TechniqueArgs) -> tuple[dict[str, Any], str]:
        entry = self._techniques.get(a.technique_id)
        if entry is None:
            return {"found": False}, f"{a.technique_id} 不在本地 ATT&CK 表中"
        tactics = entry["tactics"]
        data = {"technique_id": a.technique_id, "name": entry["name"], "tactics": tactics}
        return data, f"{a.technique_id} {entry['name']}（{'、'.join(tactics)}）"
