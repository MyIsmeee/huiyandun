"""大屏关键指标（HYD-UIX-004 §4.1 B 区，D-100），各附较 1 小时前的变化；只保存在内存中，时刻一律为墙上时钟。

活跃告警取自启动时重放的近 24 小时历史，今日已处置随重放的处置执行重建；在线设备与检测时延从启动起记录，
启动后 1 小时内没有可比数据。
"""

import math
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
from py_contracts.events.hyd_security_alert_v1_schema import SecurityAlertV1
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


def _p95(samples: list[int]) -> int | None:
    """最近秩法；没有样本为 None。"""
    return sorted(samples)[math.ceil(0.95 * len(samples)) - 1] if samples else None


class KpiTracker:
    def __init__(self, devices: Devices, history: History, now: datetime) -> None:
        self._devices = devices
        self._history = history
        # 在线台数的变化：(时刻, 台数)，保留到 1 小时前那一刻仍有效的一条
        self._online: deque[tuple[datetime, int]] = deque([(now, self._online_now())])
        self._latency: deque[tuple[datetime, int]] = deque()  # (收到时刻, 毫秒)，保留 2 小时
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

    def on_live_alert(self, event: SecurityAlertV1 | VisionBehaviorV1, now: datetime) -> None:
        """实时收到的网络告警或行为事件（不含启动时的重放）：记下从事件时刻到收到的时延。
        设备行为模型的告警（source 为 model）不计：须连续两个 30 s 窗口偏离才告警，时延是设计使然（D-100）。"""
        if isinstance(event, SecurityAlertV1) and event.source == "model":
            return
        self._latency.append((now, round((now - event.ts) / timedelta(milliseconds=1))))
        while self._latency[0][0] <= now - 2 * HOUR:
            self._latency.popleft()

    def on_execution(self, execution: PlaybookExecutionV1) -> None:
        """处置执行状态（含重放）：关联事件首次通过校验即计为已处置，之后回滚仍计入；只通知不计。"""
        if execution.state != "contained" or execution.incident_id in self._contained:
            return
        self._contained[execution.incident_id] = execution.ts
        since = execution.ts - CONTAINED_KEEP
        self._contained = {k: ts for k, ts in self._contained.items() if ts >= since}

    def read(self, day_start: datetime, now: datetime) -> Kpis:
        """day_start：浏览器本地当天 0 点。"""
        ago = now - HOUR
        online_ago = next((n for ts, n in reversed(self._online) if ts <= ago), None)
        # 1 小时前尚在昨天时，比较的是昨天截至那时的累计
        day_start_ago = day_start if ago >= day_start else day_start - DAY
        return Kpis(
            online_devices=_kpi(self._online_now(), online_ago),
            active_alerts=_kpi(self._active(now), self._active(ago)),
            contained_today=_kpi(
                self._contained_between(day_start, now), self._contained_between(day_start_ago, ago)
            ),
            detect_p95_ms=_kpi(self._p95_until(now), self._p95_until(ago)),
        )

    def _active(self, at: datetime) -> int:
        """at 时仍在保持期内的告警条数，保持时长与设备告警态一致（04 §5.2）。"""
        return sum(
            at - (PHYSICAL_HOLD if isinstance(e, VisionBehaviorV1) else CYBER_HOLD) < e.ts <= at
            for e in self._history.alerts_since(at - CYBER_HOLD)
        )

    def _contained_between(self, since: datetime, until: datetime) -> int:
        return sum(since <= ts <= until for ts in self._contained.values())

    def _p95_until(self, until: datetime) -> int | None:
        return _p95([ms for ts, ms in self._latency if until - HOUR < ts <= until])


@router.get("/kpis", dependencies=[Depends(require("viewer"))])
async def get_kpis(request: Request, day_start: AwareDatetime) -> Kpis:
    return request.app.state.kpis.read(day_start, datetime.now(UTC))
