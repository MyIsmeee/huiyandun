"""实时画面的 WebRTC 信令（FR-106）：前端不直连 go2rtc，SDP 经 api-server 鉴权后转发（D-02）。

只转发信令；媒体流由 go2rtc 的 8555 端口直达浏览器（C-OPS-05）。
"""

import logging
from typing import Annotated

import httpx2
from fastapi import APIRouter, Body, Depends, HTTPException, Request, Response

from api_server.auth import require

log = logging.getLogger(__name__)

SDP = "application/sdp"

router = APIRouter(prefix="/api")


@router.post("/devices/{device_id}/webrtc", dependencies=[Depends(require("viewer"))])
async def webrtc_signal(
    device_id: str, request: Request, offer: Annotated[bytes, Body(media_type=SDP)]
) -> Response:
    device = next((d for d in request.app.state.site.devices if d.id == device_id), None)
    if device is None or device.camera is None:
        raise HTTPException(404, "设备不存在或不是摄像头")
    if not offer.startswith(b"v=0"):
        raise HTTPException(400, "请求体须为 SDP offer")
    try:
        res = await request.app.state.go2rtc.post(
            "/api/webrtc",
            params={"src": device.camera.stream},
            content=offer,
            headers={"Content-Type": SDP},
        )
        res.raise_for_status()
    except httpx2.HTTPError as e:
        log.warning("video.signal_failed", extra={"device_id": device_id, "error": repr(e)})
        raise HTTPException(502, "视频服务不可用") from e
    return Response(res.content, media_type=SDP)
