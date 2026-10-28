"""设备状态（HYD-UIX-004 §5.2）：由行为事件与网络告警计算，只保存在内存中，重启后回到初始状态。

本模块实现告警态的进入与按时解除；offline 由 stream_lost（TK-040）、处置相关状态由
playbook 执行结果（TK-050）接入。时刻 now 为单调时钟秒数，只用于计时。
"""

from dataclasses import dataclass
from typing import Literal

from py_contracts.api import Device, WsFrame
from py_contracts.events.hyd_security_alert_v1_schema import SecurityAlertV1
from py_contracts.events.hyd_vision_behavior_v1_schema import VisionBehaviorV1

PHYSICAL_HOLD_S = 60  # 最后一次行为事件后保持物理告警的时长
CYBER_HOLD_S = 300  # 最后一次网络告警后保持网络攻击的时长，与 FR-303 的关联窗口一致

type Severity = Literal["critical", "high", "medium", "low"]
RANK: tuple[Severity, ...] = ("low", "medium", "high", "critical")


@dataclass
class _Entry:
    initial: Device
    current: Device
    physical_until: float = float("-inf")
    cyber_until: float = float("-inf")
    severity: Severity | None = None
    behavior: VisionBehaviorV1 | None = None  # 物理告警期间最近一次行为事件


class Devices:
    def __init__(self, devices: list[Device]) -> None:
        self._entries = {d.id: _Entry(initial=d, current=d) for d in devices}

    def on_behavior(self, event: VisionBehaviorV1, now: float) -> Device | None:
        """返回变化后的设备；未登记的摄像头或状态未变时返回 None。"""
        entry = self._entries.get(event.camera_id)
        if entry is None:
            return None
        entry.physical_until = now + PHYSICAL_HOLD_S
        entry.behavior = event
        return self._update(entry, now)

    def on_alert(self, event: SecurityAlertV1, now: float) -> Device | None:
        """告警等级在网络攻击期间取最高值，解除后重新累计。目标未登记为设备时返回 None（FR-203）。"""
        entry = self._entries.get(event.device_id) if event.device_id is not None else None
        if entry is None:
            return None
        active = entry.severity if now < entry.cyber_until else None
        entry.severity = (
            event.severity if active is None else max(active, event.severity, key=RANK.index)
        )
        entry.cyber_until = now + CYBER_HOLD_S
        return self._update(entry, now)

    def expire(self, now: float) -> list[Device]:
        """解除到期的告警态，返回状态变化的设备。"""
        changed = (self._update(entry, now) for entry in self._entries.values())
        return [device for device in changed if device is not None]

    def snapshot(self) -> list[WsFrame]:
        """连接建立时补推：先推全部设备，再推处于物理告警的设备的最近行为事件（供事件卡显示）。"""
        entries = self._entries.values()
        return [
            WsFrame(channel="devices", data=e.current.model_dump(mode="json")) for e in entries
        ] + [
            WsFrame(channel="alerts", data=e.behavior.model_dump(mode="json"))
            for e in entries
            if e.behavior is not None
        ]

    @staticmethod
    def _update(entry: _Entry, now: float) -> Device | None:
        physical, cyber = now < entry.physical_until, now < entry.cyber_until
        if not physical:
            entry.behavior = None
        if not cyber:
            entry.severity = None
        if physical and cyber:
            state = "both"
        elif cyber:
            state = "cyber_alert"
        elif physical:
            state = "physical_alert"
        else:
            state = entry.initial.state
        device = entry.initial.model_copy(update={"state": state, "alert_severity": entry.severity})
        if device == entry.current:
            return None
        entry.current = device
        return device
