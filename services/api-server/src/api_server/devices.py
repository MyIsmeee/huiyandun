"""设备状态（ui.md §5.1）：由行为事件与网络告警计算，只保存在内存中，重启后回到初始状态。

本模块实现告警态的进入与按时解除，处置执行对告警态的覆盖（TK-052），以及断流时的离线（FR-105）。
时刻 now 为单调时钟秒数，只用于计时。
"""

from dataclasses import dataclass, field
from typing import Literal

from py_contracts.api import Device, WsFrame
from py_contracts.events.hyd_playbook_execution_v1_schema import PlaybookExecutionV1
from py_contracts.events.hyd_security_alert_v1_schema import SecurityAlertV1
from py_contracts.events.hyd_vision_behavior_v1_schema import VisionBehaviorV1
from py_contracts.events.hyd_vision_integrity_v1_schema import VisionIntegrityV1

PHYSICAL_HOLD_S = 60  # 最后一次行为事件后保持物理告警的时长
CYBER_HOLD_S = 300  # 最后一次网络告警后保持网络攻击的时长，与 FR-303 的关联窗口一致
# 最后一次 stream_lost 后保持离线的时长：视觉引擎在断流期间每 30 s 重报（D-092）
OFFLINE_HOLD_S = 35

type Severity = Literal["critical", "high", "medium", "low"]
type Override = Literal["pending_action", "contained", "notify_only"]
# 处置执行对告警态的覆盖（ui.md §5.1）；回滚、失败、过期、跳过与等待确认不覆盖，回到按告警计算的状态。
# 同一设备有多个执行时按先后排列的优先级取最高的：仍被封禁的攻击源不因后来的执行显示为未处置
OVERRIDE: dict[str, Override] = {
    "executing": "pending_action",
    "verifying": "pending_action",
    "contained": "contained",
    "notify_only": "notify_only",
}
PRIORITY: tuple[Override, ...] = ("contained", "pending_action", "notify_only")
RANK: tuple[Severity, ...] = ("low", "medium", "high", "critical")


@dataclass
class _Entry:
    initial: Device
    current: Device
    physical_until: float = float("-inf")
    cyber_until: float = float("-inf")
    offline_until: float = float("-inf")
    severity: Severity | None = None
    behavior: VisionBehaviorV1 | None = None  # 物理告警期间最近一次行为事件
    overrides: dict[str, Override] = field(default_factory=dict)  # 执行 ID → 仍有效的覆盖


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

    def on_stream_lost(self, event: VisionIntegrityV1, now: float) -> Device | None:
        """视频流中断：置为离线，OFFLINE_HOLD_S 内未再收到即恢复（FR-105）。"""
        entry = self._entries.get(event.camera_id)
        if entry is None:
            return None
        entry.offline_until = now + OFFLINE_HOLD_S
        return self._update(entry, now)

    def on_execution(self, execution: PlaybookExecutionV1, now: float) -> list[Device]:
        """处置执行状态变化：返回状态变化的设备。"""
        changed = []
        for device_id in execution.device_ids:
            entry = self._entries.get(device_id)
            if entry is None:
                continue
            override = OVERRIDE.get(execution.state)
            if override is None:
                entry.overrides.pop(execution.id, None)
            else:
                entry.overrides[execution.id] = override
            device = self._update(entry, now)
            if device is not None:
                changed.append(device)
        return changed

    def sync(self, devices: list[Device], now: float) -> None:
        """摄像头登记表变化（D-101）：新设备从初始态开始，删除的丢弃；保留的设备沿用告警态与处置覆盖，
        按新的登记信息重算当前状态。"""
        entries = {}
        for d in devices:
            entry = self._entries.get(d.id)
            if entry is None:
                entries[d.id] = _Entry(initial=d, current=d)
                continue
            entry.initial = d
            self._update(entry, now)
            entries[d.id] = entry
        self._entries = entries

    def get(self, device_id: str) -> Device | None:
        entry = self._entries.get(device_id)
        return entry.current if entry else None

    def online(self, now: float) -> int:
        """不在断流离线期内的台数，供大屏指标（D-100）；处置状态在画面上覆盖离线，计数不受影响。"""
        return sum(now >= entry.offline_until for entry in self._entries.values())

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
            # 只通知是执行的终态，不会再有更新：随所属的这次网络攻击结束，不沿用到之后的告警
            entry.overrides = {k: v for k, v in entry.overrides.items() if v != "notify_only"}
        if physical and cyber:
            state = "both"
        elif cyber:
            state = "cyber_alert"
        elif physical:
            state = "physical_alert"
        else:
            state = entry.initial.state
        if now < entry.offline_until:
            state = "offline"  # 看不到画面时不显示告警态；处置状态仍照常覆盖
        # 处置中、已处置覆盖告警态；只通知只在网络攻击期间显示"已通知 · 待联动"（V-T1）
        override = min(entry.overrides.values(), key=PRIORITY.index, default=None)
        if override in ("pending_action", "contained") or (override == "notify_only" and cyber):
            state = override
        device = entry.initial.model_copy(update={"state": state, "alert_severity": entry.severity})
        if device == entry.current:
            return None
        entry.current = device
        return device
