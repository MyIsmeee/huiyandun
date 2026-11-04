"""关联事件写入存证（TK-080，设计 080-evidence.md §3.1、FR-701）：命中事件、关联事件与相关摄像头的录像。

录像来自 recorder（复用 MediaMTX）的回放接口：每条命中事件前后各 30 s，同一摄像头重叠的时段合并，
按实际有录像的区间逐段截取原始码流（C-EVD-02、D-098）。
"""

import asyncio
import logging
from datetime import UTC, datetime, timedelta
from uuid import UUID

import httpx2

from evidence_service.store import Chain, Entry
from py_contracts.events.event_base_schema import EventBase
from py_contracts.events.hyd_correlator_incident_v1_schema import CorrelatorIncidentV1

MARGIN = timedelta(seconds=30)  # 每条命中事件前后各取 30 s（FR-701）
FLUSH = timedelta(seconds=2)  # 等录像分片落盘后再取
CACHE = timedelta(minutes=30)  # 命中事件缓存，覆盖重放范围与规则时间窗（最长 5 分钟）

log = logging.getLogger(__name__)


def windows(times: list[datetime]) -> list[tuple[datetime, datetime]]:
    """每个时刻前后各 MARGIN，重叠的合并，按先后排列。"""
    merged: list[tuple[datetime, datetime]] = []
    for start, end in sorted((t - MARGIN, t + MARGIN) for t in times):
        if merged and start <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    return merged


def _iso(t: datetime) -> str:
    return t.astimezone(UTC).isoformat(timespec="milliseconds")


class Evidence:
    def __init__(self, chain: Chain, cameras: dict[str, str], recorder: httpx2.AsyncClient) -> None:
        """cameras：设备 ID → recorder 中的路径名（site.yaml 的 stream）。"""
        self._chain = chain
        self._cameras = cameras
        self._recorder = recorder
        self._events: dict[UUID, tuple[str, EventBase]] = {}
        self._lock = asyncio.Lock()  # 追加串行、导出不读到半批记录
        self._tasks: dict[str, asyncio.Task[None]] = {}

    def cache(self, kind: str, event: EventBase) -> None:
        self._events[event.event_id] = (kind, event)
        cutoff = datetime.now(UTC) - CACHE
        while self._events and next(iter(self._events.values()))[1].ts < cutoff:
            del self._events[next(iter(self._events))]

    async def on_incident(self, incident: CorrelatorIncidentV1) -> None:
        """立即返回：等待录像期间不阻塞订阅。链中已有或正在写入的关联事件跳过（重放幂等）。"""
        if incident.id in self._chain.incidents or incident.id in self._tasks:
            return
        task = asyncio.create_task(self._record(incident))
        self._tasks[incident.id] = task
        task.add_done_callback(lambda _: self._tasks.pop(incident.id, None))

    async def _record(self, incident: CorrelatorIncidentV1) -> None:
        try:
            # 命中事件都早于关联事件：等到关联事件后 MARGIN + FLUSH，各时段的录像都已落盘。等完再查缓存：
            # 告警与关联事件来自不同的流，到达先后没有保证
            ready = incident.ts + MARGIN + FLUSH
            await asyncio.sleep(max((ready - datetime.now(UTC)).total_seconds(), 0))
            hits = [(event_id, self._events.get(event_id)) for event_id in incident.hit_path]
            spans = windows([c[1].ts for _, c in hits if c] or [incident.ts])
            entries = [
                Entry(c[0], incident.id, {"event_id": str(i)}, c[1].model_dump_json().encode())
                if c
                else Entry("event_missing", incident.id, {"event_id": str(i)})
                for i, c in hits
            ]
            entries.append(Entry("incident", incident.id, {}, incident.model_dump_json().encode()))
            for device_id in incident.device_ids:
                if (stream := self._cameras.get(device_id)) is not None:
                    for start, end in spans:
                        entries += await self._clips(incident.id, device_id, stream, start, end)
            async with self._lock:
                await asyncio.to_thread(self._chain.append, entries)
            log.info(
                "evidence.recorded", extra={"incident_id": incident.id, "records": len(entries)}
            )
        except Exception:
            log.exception("evidence.record_failed", extra={"incident_id": incident.id})

    async def _clips(
        self, incident_id: str, device_id: str, stream: str, start: datetime, end: datetime
    ) -> list[Entry]:
        """该时段内每个连续录像区间一条记录：取到为 video，取失败为 video_unavailable；没有录像或
        查不到区间时整个时段一条 video_unavailable。"""
        meta = {
            "device_id": device_id,
            "stream": stream,
            "capture_host": self._recorder.base_url.host,
        }

        def unavailable(start: datetime, end: datetime, reason: str) -> Entry:
            span = meta | {"start": _iso(start), "end": _iso(end), "reason": reason}
            return Entry("video_unavailable", incident_id, span)

        try:
            res = await self._recorder.get(
                "/list", params={"path": stream, "start": _iso(start), "end": _iso(end)}
            )
            if res.status_code == 404:
                return [unavailable(start, end, "该时段无录像")]
            res.raise_for_status()
            spans = [
                (s["start"], datetime.fromisoformat(s["start"]), float(s["duration"]))
                for s in res.json()
            ]
        except (httpx2.HTTPError, ValueError, KeyError, TypeError) as e:
            log.warning(
                "evidence.recorder_failed", extra={"device_id": device_id, "error": repr(e)}
            )
            return [unavailable(start, end, f"录像不可用：{e!r}")]
        clips = []
        for raw_start, clip_start, duration in spans:
            clip_end = clip_start + timedelta(seconds=duration)
            try:
                clip = await self._recorder.get(
                    "/get",
                    params={
                        "path": stream,
                        "start": raw_start,
                        "duration": duration,
                        "format": "mp4",
                    },
                )
                clip.raise_for_status()
            except httpx2.HTTPError as e:
                log.warning(
                    "evidence.recorder_failed", extra={"device_id": device_id, "error": repr(e)}
                )
                clips.append(unavailable(clip_start, clip_end, f"录像不可用：{e!r}"))
                continue
            span = meta | {"start": _iso(clip_start), "end": _iso(clip_end)}
            clips.append(Entry("video", incident_id, span, clip.content, "mp4"))
        return clips

    async def package(self, incident_id: str) -> bytes | None:
        async with self._lock:
            return await asyncio.to_thread(self._chain.package, incident_id)
