"""关联引擎（TK-041，设计 docs/design/041-correlation-engine.md）：按规则把同一设备窗口内先后出现的
事件合并为关联事件。判定只由规则完成，不依赖 LLM（FR-305、G-03）。

时间一律取事件自带的 ts：探针与视觉事件到达先后可能与发生先后不一致，按发生先后判断序列。
"""

import logging
import uuid
from collections import defaultdict
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from correlator.rules import Event, Rule, Step
from py_contracts.events.hyd_correlator_incident_v1_schema import CorrelatorIncidentV1
from py_contracts.events.hyd_security_alert_v1_schema import SecurityAlertV1
from py_contracts.events.hyd_vision_behavior_v1_schema import VisionBehaviorV1

SCHEMA_VERSION = "1.2.0"  # 1.2：mode（D-068）
# 同一规则、同一设备生成关联事件后，持续出现的命中事件在此时长内不再生成新事件（D-067）
SUPPRESS = timedelta(minutes=5)
# 关联事件 ID 由规则 ID 与命中事件派生：重启后重放同一序列得到同一 ID，JetStream 据此去重
INCIDENT_NAMESPACE = uuid.UUID("8f6c2d1e-3b7a-4c55-9e0f-6a1d2b3c4e5f")

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class _Hit:
    step: int
    subject: str
    event: Event


def _key(event: Event) -> str | None:
    """关联键 device_id：告警取 device_id（目标未登记时为 null），视觉事件取 camera_id。"""
    if isinstance(event, SecurityAlertV1):
        return event.device_id
    return event.camera_id


def _matches(step: Step, subject: str, event: Event) -> bool:
    if step.subject != subject:
        return False
    for field, expected in step.match.items():
        value = getattr(event, field)
        if value not in expected if isinstance(expected, list) else value != expected:
            return False
    return True


def _chain(rule: Rule, hits: list[_Hit]) -> list[_Hit] | None:
    """按 ts 先后、每步各取一个不同事件的完整序列；有多条时取起点最晚的一条（证据最新）。"""
    ordered = sorted(hits, key=lambda h: h.event.ts)
    for start in reversed([h for h in ordered if h.step == 0]):
        chain = [start]
        for step in range(1, len(rule.sequence)):
            used = {h.event.event_id for h in chain}
            following = (
                h
                for h in ordered
                if h.step == step
                and h.event.ts >= chain[-1].event.ts
                and h.event.event_id not in used
            )
            nxt = next(following, None)
            if nxt is None:
                break
            chain.append(nxt)
        else:
            return chain
    return None


def _requires_confirmation(chain: list[_Hit]) -> bool:
    """命中路径含模型来源的告警或画面事件（FR-407），或含骨骼姿态判定的行为事件（D-069）。"""
    return any(
        isinstance(h.event, VisionBehaviorV1) or getattr(h.event, "source", None) == "model"
        for h in chain
    )


class Engine:
    def __init__(self, rules: list[Rule], attack: dict[str, Any]) -> None:
        self._rules = rules
        self._techniques: dict[str, dict[str, Any]] = attack["techniques"]
        self._tactic_rank = {t: i for i, t in enumerate(attack["tactic_order"])}
        self._hits: dict[tuple[str, str], list[_Hit]] = defaultdict(list)
        self._quiet_until: dict[tuple[str, str], datetime] = {}

    def restore(self, incident: CorrelatorIncidentV1) -> None:
        """重启时以近期已生成的关联事件恢复去重状态，避免重放事件时再生成一次。"""
        for device in incident.device_ids:
            until = incident.created_at + SUPPRESS
            key = (incident.rule_id, device)
            self._quiet_until[key] = max(until, self._quiet_until.get(key, until))

    def feed(self, subject: str, event: Event) -> list[CorrelatorIncidentV1]:
        device = _key(event)
        # monitor 告警只显示，不参与关联（D-068）
        if device is None or (isinstance(event, SecurityAlertV1) and event.mode == "monitor"):
            return []
        incidents = []
        for rule in self._rules:
            steps = [i for i, s in enumerate(rule.sequence) if _matches(s, subject, event)]
            if not steps:
                continue
            key = (rule.id, device)
            quiet = self._quiet_until.get(key)
            if quiet is not None and event.ts < quiet:
                # 攻击仍在持续：顺延去重期（只顺延、不提前），攻击停止 5 分钟后再次出现才算新事件（D-067）
                self._quiet_until[key] = max(quiet, event.ts + SUPPRESS)
                continue
            hits = self._hits[key]
            hits += [_Hit(i, subject, event) for i in steps]
            newest = max(h.event.ts for h in hits)
            hits[:] = [h for h in hits if h.event.ts >= newest - timedelta(seconds=rule.window_s)]
            chain = _chain(rule, hits)
            if chain is None:
                continue
            hits.clear()
            self._quiet_until[key] = chain[-1].event.ts + SUPPRESS
            incidents.append(self._incident(rule, device, chain))
        return incidents

    def _tactics(self, techniques: list[str]) -> list[str]:
        tactics: set[str] = set()
        for technique in techniques:
            known = self._techniques.get(technique)
            if known is None:
                log.warning("correlator.technique_unknown", extra={"technique": technique})
                continue
            tactics.update(known["tactics"])
        return sorted(tactics, key=self._tactic_rank.__getitem__)

    def _incident(self, rule: Rule, device: str, chain: list[_Hit]) -> CorrelatorIncidentV1:
        hit_path = [h.event.event_id for h in chain]
        incident_id = uuid.uuid5(INCIDENT_NAMESPACE, rule.id + "".join(map(str, hit_path)))
        alerts = [h.event for h in chain if isinstance(h.event, SecurityAlertV1)]
        now = datetime.now(UTC)
        return CorrelatorIncidentV1(
            schema_version=SCHEMA_VERSION,
            event_id=incident_id,
            ts=now,
            id=str(incident_id),
            rule_id=rule.id,
            rule_version=rule.version,
            mode=rule.mode,
            title=rule.emit.title,
            severity=rule.emit.severity,
            device_ids=[device],
            source_ip=alerts[0].src_ip if alerts else None,
            techniques=rule.emit.techniques,
            tactics=self._tactics(rule.emit.techniques),
            evidence_refs=[
                h.event.evidence_ref
                if isinstance(h.event, SecurityAlertV1)
                else f"{h.subject}/{h.event.event_id}"
                for h in chain
            ],
            hit_path=hit_path,
            requires_confirmation=_requires_confirmation(chain),
            status="open",
            created_at=now,
        )
