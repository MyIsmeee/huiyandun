"""导出证据包（FR-702、TK-080）：经 api-server 鉴权后向 evidence-service 取包，写入审计后返回（G-13）；
单条告警前后的录像回放也经 evidence-service 向 recorder 取。

包由 evidence-service 组装并签名（设计 080-evidence.md §4）；本模块不解析包内容。
"""

import hashlib
import logging
from datetime import UTC, datetime, timedelta
from typing import Annotated
from urllib.parse import quote
from uuid import UUID

import httpx2
from fastapi import APIRouter, Depends, HTTPException, Request, Response

from api_server.audit import record
from api_server.auth import Principal, require
from py_contracts.events.event_base_schema import EventBase
from py_contracts.events.hyd_vision_behavior_v1_schema import VisionBehaviorV1
from py_contracts.events.hyd_vision_rule_v1_schema import VisionRuleV1

UNREACHABLE = "存证服务暂不可达，请稍后重试"

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api")


@router.post("/incidents/{incident_id}/evidence/export")
async def export_evidence(
    incident_id: str,
    request: Request,
    principal: Annotated[Principal, Depends(require("operator"))],
) -> Response:
    """审计提交后才返回文件：审计写入失败时不交出证据包。"""
    try:
        res = await request.app.state.evidence.get(
            f"/internal/incidents/{quote(incident_id, safe='')}/package"
        )
    except httpx2.HTTPError as e:
        log.warning("evidence.export_failed", extra={"incident_id": incident_id, "error": repr(e)})
        raise HTTPException(503, UNREACHABLE) from e
    if res.status_code == 404:
        raise HTTPException(404, "存证尚未写入或没有记录，请稍后重试")  # 关联事件后约 32 s 才写入
    if res.status_code != 200:
        log.warning(
            "evidence.export_failed", extra={"incident_id": incident_id, "status": res.status_code}
        )
        raise HTTPException(503, UNREACHABLE)
    async with request.app.state.engine.begin() as conn:
        await record(
            conn,
            actor=principal.username,
            action="evidence.exported",
            target=incident_id,
            before=None,
            after={"sha256": hashlib.sha256(res.content).hexdigest(), "bytes": len(res.content)},
            request_id=request.state.request_id,
        )
    return Response(
        res.content,
        media_type="application/octet-stream",
        headers={"Content-Disposition": f'attachment; filename="evidence-{incident_id}.zip"'},
    )


CLIP_PRE = timedelta(seconds=10)  # 告警开始前回看
CLIP_POST = timedelta(seconds=10)  # 告警后续看
CLIP_MAX = timedelta(seconds=45)  # 手机推流码率高（约 20 Mbps），片段不宜过长
CLIP_FLUSH = timedelta(seconds=2)  # 录像分片落盘需要的时间：更近的部分还取不到


def clip_window(event: EventBase, now: datetime) -> tuple[datetime, datetime] | None:
    """单条告警回放的时段：行为事件从开始（倒地等）前 10 s 到确认后 10 s，区域与越线从发生前 10 s 起；
    不超过 45 秒，截止于 2 s 前（之后的录像尚未落盘）。告警刚发生时返回的片段较短；时段已全在未来时为 None"""
    if isinstance(event, VisionBehaviorV1):
        begin = event.ts_start
    elif isinstance(event, VisionRuleV1):
        begin = event.since
    else:
        begin = event.ts
    end = min(event.ts + CLIP_POST, now - CLIP_FLUSH)
    start = max(begin - CLIP_PRE, end - CLIP_MAX)
    return (start, end) if end > start else None


@router.get("/alerts/{event_id}/clip", dependencies=[Depends(require("viewer"))])
async def alert_clip(event_id: UUID, request: Request) -> Response:
    """单条物理告警前后的录像（控制台回放，不落盘、不写审计）；viewer 本就可观看同一路实时画面。"""
    event = request.app.state.history.event(event_id)
    camera = getattr(event, "camera_id", None)
    if event is None or camera is None:
        raise HTTPException(404, "告警不存在、已超过 24 小时或不是摄像头告警")
    window = clip_window(event, datetime.now(UTC))
    if window is None:
        raise HTTPException(404, "录像还在写入，请几秒后再试")
    start, end = window
    try:
        res = await request.app.state.evidence.get(
            f"/internal/clips/{quote(camera, safe='')}",
            params={"start": start.isoformat(), "end": end.isoformat()},
        )
    except httpx2.HTTPError as e:
        log.warning("evidence.clip_failed", extra={"device_id": camera, "error": repr(e)})
        raise HTTPException(503, UNREACHABLE) from e
    if res.status_code == 404:
        raise HTTPException(404, "该时段没有录像：录像服务当时可能未在录这路画面")
    if res.status_code != 200:
        log.warning("evidence.clip_failed", extra={"device_id": camera, "status": res.status_code})
        raise HTTPException(503, UNREACHABLE)
    return Response(
        res.content, media_type="video/mp4", headers={"Cache-Control": "private, max-age=300"}
    )
