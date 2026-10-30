"""近 24 小时的告警、关联事件与处置执行（D-077）：只保存在内存中，启动时从 JetStream 重放；连接建立时补推，
页面刷新后告警列表不丢。"""

from collections import OrderedDict, deque
from datetime import UTC, datetime, timedelta

from py_contracts.api import WsFrame
from py_contracts.events.event_base_schema import EventBase
from py_contracts.events.hyd_playbook_execution_v1_schema import PlaybookExecutionV1

WINDOW = timedelta(hours=24)
MAX_ALERTS, MAX_INCIDENTS, MAX_EXECUTIONS = 200, 50, 50


class History:
    def __init__(self) -> None:
        self._alerts: deque[EventBase] = deque(maxlen=MAX_ALERTS)
        self._incidents: deque[EventBase] = deque(maxlen=MAX_INCIDENTS)
        self._executions: OrderedDict[str, PlaybookExecutionV1] = OrderedDict()

    def add_alert(self, event: EventBase) -> None:
        """网络告警或行为事件。"""
        self._alerts.append(event)

    def add_incident(self, event: EventBase) -> None:
        self._incidents.append(event)

    def add_execution(self, execution: PlaybookExecutionV1) -> None:
        """每个执行只保留最新状态。"""
        self._executions.pop(execution.id, None)
        self._executions[execution.id] = execution
        while len(self._executions) > MAX_EXECUTIONS:
            self._executions.popitem(last=False)

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
