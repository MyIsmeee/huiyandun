"""导出证据包（FR-702、TK-080）：经 api-server 鉴权后向 evidence-service 取包，写入审计后返回（G-13）。

包由 evidence-service 组装并签名（设计 080-evidence.md §4）；本模块不解析包内容。
"""

import hashlib
import logging
from typing import Annotated
from urllib.parse import quote

import httpx2
from fastapi import APIRouter, Depends, HTTPException, Request, Response

from api_server.audit import record
from api_server.auth import Principal, require

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
