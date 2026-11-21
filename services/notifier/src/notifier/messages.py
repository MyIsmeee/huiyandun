"""通知内容与各平台的请求格式。只含纯函数，便于测试。"""

import base64
import hashlib
import hmac
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Literal
from urllib.parse import quote

from py_contracts.events.hyd_correlator_incident_v1_schema import CorrelatorIncidentV1
from py_contracts.events.hyd_vision_behavior_v1_schema import VisionBehaviorV1
from py_contracts.events.hyd_vision_rule_v1_schema import VisionRuleV1

BEHAVIOR = {"fall": "跌倒", "climb": "攀爬越界", "still": "长时间静止", "fight": "打架"}
RULE = {"intrusion": "区域入侵", "line_crossing": "越线"}
SEVERITY = {"critical": "严重", "high": "高", "medium": "中", "low": "低"}

Kind = Literal["wecom", "dingtalk", "webhook"]


@dataclass(frozen=True)
class Notice:
    """一条通知：key 用于冷却（同一摄像头、同一类告警），title 与 lines 为正文。"""

    key: str
    title: str
    lines: list[str]
    event: dict[str, Any]


def _local(t: datetime, offset_min: int) -> str:
    return t.astimezone(timezone(timedelta(minutes=offset_min))).strftime("%Y-%m-%d %H:%M:%S")


def notice(
    event: VisionBehaviorV1 | VisionRuleV1 | CorrelatorIncidentV1,
    names: dict[str, str],
    offset_min: int,
) -> Notice | None:
    """需要通知的事件转为通知；疑似、区域持续与离开、低等级的关联事件不通知（返回 None）。"""
    if isinstance(event, CorrelatorIncidentV1):
        if event.severity not in ("critical", "high"):
            return None
        devices = "、".join(names.get(d, d) for d in event.device_ids) or "—"
        lines = [f"等级：{SEVERITY[event.severity]}", f"设备：{devices}"]
        if event.source_ip:
            lines.append(f"攻击源：{event.source_ip}")
        lines.append(f"时间：{_local(event.created_at, offset_min)}")
        return Notice(
            f"incident/{event.rule_id}/{event.source_ip}",
            event.title,
            lines,
            event.model_dump(mode="json"),
        )
    if event.level != "confirmed":
        return None
    camera = names.get(event.camera_id, event.camera_id)
    if isinstance(event, VisionRuleV1):
        if event.phase not in ("start", "pulse"):
            return None
        title = f"{RULE.get(event.rule_type, event.rule_type)} · {event.rule_name}"
        key = f"rule/{event.camera_id}/{event.rule_id}"
        at = event.since
    else:
        title = BEHAVIOR.get(event.behavior, event.behavior)
        key = f"behavior/{event.camera_id}/{event.behavior}"
        at = event.ts_start
    lines = [f"摄像头：{camera}", f"人员：#{event.track_id}", f"发生时间：{_local(at, offset_min)}"]
    return Notice(key, title, lines, event.model_dump(mode="json"))


def markdown(n: Notice, console_url: str | None) -> str:
    body = "\n".join(f"> {line}" for line in n.lines)
    link = f"\n\n[打开控制台处置]({console_url})" if console_url else "\n\n请登录控制台处置"
    return f"**【慧眼盾】{n.title}**\n{body}{link}"


def request(
    kind: Kind, url: str, secret: str | None, n: Notice, console_url: str | None
) -> tuple[str, dict[str, Any]]:
    """各平台的 (请求地址, JSON 体)。钉钉配置了加签密钥时在地址后附 timestamp 与 sign。"""
    text = markdown(n, console_url)
    if kind == "wecom":
        return url, {"msgtype": "markdown", "markdown": {"content": text}}
    if kind == "dingtalk":
        if secret:
            ts = str(round(time.time() * 1000))
            digest = hmac.new(secret.encode(), f"{ts}\n{secret}".encode(), hashlib.sha256).digest()
            sign = quote(base64.b64encode(digest).decode(), safe="")
            url = f"{url}{'&' if '?' in url else '?'}timestamp={ts}&sign={sign}"
        return url, {
            "msgtype": "markdown",
            "markdown": {"title": f"慧眼盾：{n.title}", "text": text},
        }
    return url, {"title": n.title, "lines": n.lines, "text": text, "event": n.event}
