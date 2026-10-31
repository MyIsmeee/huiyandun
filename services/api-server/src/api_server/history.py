"""近 24 小时的告警、关联事件与处置执行（D-077）：只保存在内存中，启动时从 JetStream 重放；连接建立时补推，
页面刷新后告警列表不丢。画面完整性事件只供报告按命中路径查找（TK-070），不补推。"""

from collections import OrderedDict, deque
from datetime import UTC, datetime, timedelta
from uuid import UUID

from py_contracts.api import WsFrame
from py_contracts.events.event_base_schema import EventBase
from py_contracts.events.hyd_correlator_incident_v1_schema import CorrelatorIncidentV1
from py_contracts.events.hyd_playbook_execution_v1_schema import PlaybookExecutionV1

WINDOW = timedelta(hours=24)
MAX_ALERTS, MAX_INCIDENTS, MAX_EXECUTIONS = 200, 50, 50


def _recent(event: EventBase) -> bool:
    return event.ts >= datetime.now(UTC) - WINDOW


class History:
    def __init__(self) -> None:
        self._alerts: deque[EventBase] = deque(maxlen=MAX_ALERTS)
        self._incidents: deque[CorrelatorIncidentV1] = deque(maxlen=MAX_INCIDENTS)
        self._integrity: deque[EventBase] = deque(maxlen=MAX_ALERTS)
        self._executions: OrderedDict[str, PlaybookExecutionV1] = OrderedDict()

    def add_alert(self, event: EventBase) -> None:
        """网络告警或行为事件。"""
        self._alerts.append(event)

    def add_incident(self, event: CorrelatorIncidentV1) -> None:
        self._incidents.append(event)

    def add_integrity(self, event: EventBase) -> None:
        self._integrity.append(event)

    def incident(self, incident_id: str) -> CorrelatorIncidentV1 | None:
        """关联事件的最新状态；超过 24 小时或超出条数上限时为 None。"""
        latest = next((i for i in reversed(self._incidents) if i.id == incident_id), None)
        return latest if latest and _recent(latest) else None

    def event(self, event_id: UUID) -> EventBase | None:
        """命中路径中的告警、行为或画面完整性事件；超过 24 小时、超出条数上限或未收到时为 None。"""
        events = (*self._alerts, *self._integrity)
        return next((e for e in events if e.event_id == event_id and _recent(e)), None)

    def executions_of(self, incident_id: str) -> list[PlaybookExecutionV1]:
        return [e for e in self._executions.values() if e.incident_id == incident_id]

    def add_execution(self, execution: PlaybookExecutionV1) -> None:
        """每个执行只保留最新状态。"""
        self._executions.pop(execution.id, None)
        self._executions[execution.id] = execution
        while len(self._executions) > MAX_EXECUTIONS:
            self._executions.popitem(last=False)

    def execution(self, execution_id: str) -> PlaybookExecutionV1 | None:
        """执行的最新状态；超出保留范围时为 None。"""
        return self._executions.get(execution_id)

    def snapshot(self) -> list[WsFrame]:
        """近 24 小时的记录，按发生先后排列。"""
        since = datetime.now(UTC) - WINDOW
        frames = [
            (event.ts, channel, event)
            for channel, events in (
                ("alerts", self._alerts),
                ("incidents", self._incidents),
                ("executions", self._executions.values()),
            )
            for event in events
            if event.ts >= since
        ]
        return [
            WsFrame(channel=channel, data=event.model_dump(mode="json"))
            for _, channel, event in sorted(frames, key=lambda f: f[0])
        ]
