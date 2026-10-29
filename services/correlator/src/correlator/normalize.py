"""归一化（TK-032）：Suricata EVE 告警 → hyd.security.alert.v1，按目标 IP 补全 device_id（FR-203）。

EVE 来自解析不可信流量的探针，按模型校验后才取用；不合格的记录记日志后跳过。
"""

import logging
import uuid
from datetime import UTC
from ipaddress import IPv4Address, IPv6Address

from pydantic import AwareDatetime, BaseModel, ValidationError

from py_contracts.config.site_schema import SiteConfig
from py_contracts.events.hyd_security_alert_v1_schema import SecurityAlertV1

SCHEMA_VERSION = "1.1.0"  # 1.1：来源、可信度、说明（C-SEC-09）
# event_id 由 EVE 原文派生：重启后重读未确认的一行时 ID 不变，由 JetStream 去重
EVENT_NAMESPACE = uuid.UUID("5d0f6a52-4b0e-4f0c-9a51-3c7f3e0c7a10")
# Suricata 优先级 1 最高；critical 留给跨域关联事件（HYD-PLAN-007 §4）
SEVERITY = {1: "high", 2: "medium"}

type Ip = IPv4Address | IPv6Address

log = logging.getLogger(__name__)


class _Endpoint(BaseModel):
    ip: Ip


class _Alert(BaseModel):
    signature_id: int
    rev: int
    signature: str
    category: str
    severity: int
    # 规则以 target 关键字标明受害方时才有；否则按报文方向，源即攻击方
    source: _Endpoint | None = None
    target: _Endpoint | None = None
    metadata: dict[str, list[str]] = {}


class _Eve(BaseModel):
    timestamp: AwareDatetime
    flow_id: int
    src_ip: Ip
    dest_ip: Ip
    alert: _Alert


def device_index(site: SiteConfig) -> dict[Ip, str]:
    """设备登记表：IP → 设备 ID。"""
    return {camera.ip: camera.id for camera in site.cameras}


def normalize(line: str, devices: dict[Ip, str]) -> SecurityAlertV1 | None:
    """返回归一化后的告警；记录不合格（探针只输出告警，其他类型同样视为不合格）或缺 ATT&CK
    技术编号（C-SEC-09）时返回 None。"""
    try:
        eve = _Eve.model_validate_json(line)
    except ValidationError as e:
        log.warning("correlator.eve_invalid", extra={"error": str(e)})
        return None
    alert = eve.alert
    meta = {key: values[0] for key, values in alert.metadata.items() if values}
    technique = meta.get("mitre_technique_id")
    if technique is None:
        log.info("correlator.alert_skipped", extra={"sid": alert.signature_id})
        return None
    src = alert.source.ip if alert.source else eve.src_ip
    dst = alert.target.ip if alert.target else eve.dest_ip
    try:
        return SecurityAlertV1(
            schema_version=SCHEMA_VERSION,
            event_id=uuid.uuid5(EVENT_NAMESPACE, line),
            ts=eve.timestamp.astimezone(UTC),
            # 自研规则带 HYD 规则 ID 与类别；外部规则以 sid 标识、取其 classtype
            rule_id=meta.get("hyd_rule_id", f"SID-{alert.signature_id}"),
            rule_version=str(alert.rev),
            category=meta.get("hyd_category", alert.category),
            severity=SEVERITY.get(alert.severity, "low"),
            src_ip=src,
            dst_ip=dst,
            device_id=devices.get(dst),
            technique=technique,
            evidence_ref=f"suricata:flow/{eve.flow_id}",
            source="rule",
            confidence=1.0,
            summary=alert.signature,
        )
    except ValidationError as e:
        log.warning("correlator.alert_invalid", extra={"sid": alert.signature_id, "error": str(e)})
        return None
