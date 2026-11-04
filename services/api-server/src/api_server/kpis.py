"""大屏关键指标（HYD-UIX-004 §4.1 B 区，D-100、D-106）：前三项附较 1 小时前的变化，最近处置用时附较上一次的变化；
只保存在内存中，时刻一律为墙上时钟。

活跃告警取自启动时重放的近 24 小时历史，今日已处置与处置用时随重放的处置执行重建；在线设备从启动起记录，
启动后 1 小时内没有可比数据。
"""

import time
from collections import deque
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, Request
from pydantic import AwareDatetime

from api_server.auth import require
from api_server.devices import CYBER_HOLD_S, PHYSICAL_HOLD_S, Devices
from api_server.history import History
from py_contracts.api import Kpi, Kpis
from py_contracts.events.hyd_playbook_execution_v1_schema import PlaybookExecutionV1
from py_contracts.events.hyd_vision_behavior_v1_schema import VisionBehaviorV1

HOUR = timedelta(hours=1)
DAY = timedelta(days=1)
CONTAINED_KEEP = 2 * DAY  # 今日与昨日的累计都用得到
PHYSICAL_HOLD = timedelta(seconds=PHYSICAL_HOLD_S)
CYBER_HOLD = timedelta(seconds=CYBER_HOLD_S)

router = APIRouter(prefix="/api")


def _kpi(value: int | None, before: int | None) -> Kpi:
    delta = None if value is None or before is None else value - before
    return Kpi(value=value, delta=delta)


class KpiTracker:
    def __init__(self, devices: Devices, history: History, now: datetime) -> None:
        self._devices = devices
        self._history = history
        # 在线台数的变化：(时刻, 台数)，保留到 1 小时前那一刻仍有效的一条
        self._online: deque[tuple[datetime, int]] = deque([(now, self._online_now())])
        self._contained: dict[str, datetime] = {}  # 关联事件 → 首次处置通过校验的时刻

    def _online_now(self) -> int:
        return self._devices.online(time.monotonic())  # 设备状态按单调时钟计时（devices.py）

    def tick(self, now: datetime) -> None:
        """由每秒一次的告警态到期检查调用，记录在线台数的变化。"""
        online = self._online_now()
        if online != self._online[-1][1]:
            self._online.append((now, online))
        while len(self._online) > 1 and self._online[1][0] <= now - HOUR:
            self._online.popleft()

    def on_execution(self, execution: PlaybookExecutionV1) -> None:
        """处置执行状态（含重放）：关联事件首次通过校验即计为已处置，之后回滚仍计入；只通知不计。"""
        if execution.state != "contained" or execution.incident_id in self._contained:
            return
        self._contained[execution.incident_id] = execution.ts
        since = execution.ts - CONTAINED_KEEP
        self._contained = {k: ts for k, ts in self._contained.items() if ts >= since}

    def _contain_ms(self) -> list[int]:
        """最近两次处置的用时（毫秒），新的在前。读取时才查关联事件：启动重放时处置执行可能先于关联事件到达。"""
        durations = []
        for incident_id, ts in sorted(self._contained.items(), key=lambda kv: kv[1], reverse=True):
            start = self._attack_start(incident_id)
            if start is not None:
                durations.append(max(0, round((ts - start) / timedelta(milliseconds=1))))
            if len(durations) == 2:
                break
        return durations

    def _attack_start(self, incident_id: str) -> datetime | None:
        """关联事件命中路径中最早事件的时刻（如首条爆破告警）；命中事件已不在历史中时取关联事件生成时刻。"""
        incident = self._history.incident(incident_id)
        if incident is None:
            return None
        hits = [e.ts for e in map(self._history.event, incident.hit_path) if e is not None]
        return min(hits, default=incident.created_at)

    def read(self, day_start: datetime, now: datetime) -> Kpis:
        """day_start：浏览器本地当天 0 点。"""
        ago = now - HOUR
        online_ago = next((n for ts, n in reversed(self._online) if ts <= ago), None)
        # 1 小时前尚在昨天时，比较的是昨天截至那时的累计
        day_start_ago = day_start if ago >= day_start else day_start - DAY
        recent = self._contain_ms()
        return Kpis(
            online_devices=_kpi(self._online_now(), online_ago),
            active_alerts=_kpi(self._active(now), self._active(ago)),
            contained_today=_kpi(
                self._contained_between(day_start, now), self._contained_between(day_start_ago, ago)
            ),
            last_contain_ms=_kpi(
                recent[0] if recent else None, recent[1] if len(recent) > 1 else None
            ),
        )

    def _active(self, at: datetime) -> int:
        """at 时仍在保持期内的告警条数，保持时长与设备告警态一致（04 §5.2）。"""
        return sum(
            at - (PHYSICAL_HOLD if isinstance(e, VisionBehaviorV1) else CYBER_HOLD) < e.ts <= at
            for e in self._history.alerts_since(at - CYBER_HOLD)
        )

    def _contained_between(self, since: datetime, until: datetime) -> int:
        return sum(since <= ts <= until for ts in self._contained.values())


@router.get("/kpis", dependencies=[Depends(require("viewer"))])
async def get_kpis(request: Request, day_start: AwareDatetime) -> Kpis:
    return request.app.state.kpis.read(day_start, datetime.now(UTC))
