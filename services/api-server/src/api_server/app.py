"""FastAPI 应用：X-Request-ID 透传（C-BE-08）与统一错误格式（契约 Error）。"""

import asyncio
import logging
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, suppress
from http import HTTPStatus

import httpx2
from fastapi import FastAPI, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from sqlalchemy import text
from starlette.datastructures import Headers, MutableHeaders
from starlette.exceptions import HTTPException
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from api_server import (
    audit,
    auth,
    containment,
    executions,
    llm,
    llm_probe,
    relay,
    reports,
    site,
    video,
    ws,
)
from api_server.config import ApiConfig
from api_server.db import create_engine
from api_server.devices import Devices
from api_server.history import History
from py_common.bus import Bus
from py_common.log import bind_request_id

log = logging.getLogger(__name__)

WRITE_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})


def error_response(status: int, message: str, request_id: str) -> JSONResponse:
    code = HTTPStatus(status).name.lower()
    return JSONResponse(
        {"code": code, "message": message, "request_id": request_id}, status_code=status
    )


class RequestIdMiddleware:
    """写操作必须携带 X-Request-ID；其余请求缺省时生成。请求 ID 绑定到日志并回写响应头。"""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return
        request_id = Headers(scope=scope).get("x-request-id")
        if not request_id:
            request_id = str(uuid.uuid4())
            if scope["type"] == "http" and scope["method"] in WRITE_METHODS:
                response = error_response(400, "写操作须携带 X-Request-ID", request_id)
                response.headers["X-Request-ID"] = request_id
                await response(scope, receive, send)
                return
        scope.setdefault("state", {})["request_id"] = request_id

        started = False

        async def send_with_id(message: Message) -> None:
            nonlocal started
            if message["type"] == "http.response.start":
                started = True
                MutableHeaders(scope=message)["X-Request-ID"] = request_id
            await send(message)

        with bind_request_id(request_id):
            try:
                await self.app(scope, receive, send_with_id)
            except Exception:
                # 响应已开始或为 WebSocket 时无法改写响应，交由服务器记录
                if scope["type"] != "http" or started:
                    raise
                # 未捕获的异常同样返回契约 Error 并带请求 ID，以便对照日志排查；不返回内部细节
                log.exception("http.unhandled_error")
                await error_response(500, "服务器内部错误", request_id)(
                    scope, receive, send_with_id
                )


async def on_http_error(request: Request, exc: HTTPException) -> JSONResponse:
    return error_response(exc.status_code, str(exc.detail), request.state.request_id)


async def on_validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:
    message = "; ".join(f"{'.'.join(map(str, e['loc']))}: {e['msg']}" for e in exc.errors())
    return error_response(400, message, request.state.request_id)


def create_app(config: ApiConfig) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        bus = await Bus.connect(config.nats_url, name="api-server", timeout_s=config.nats_timeout_s)
        app.state.bus = bus  # 手动回滚经它发布请求
        app.state.engine = create_engine(config)
        app.state.go2rtc = httpx2.AsyncClient(
            base_url=config.go2rtc_url, timeout=config.go2rtc_timeout_s
        )
        # 超时按供应商配置逐次给出（llm_probe.forward）
        app.state.llm_gateway = httpx2.AsyncClient(base_url=config.llm_gateway_url)
        tasks = [
            asyncio.create_task(ws.heartbeat(app.state.hub)),
            asyncio.create_task(relay.expire(app.state.hub, app.state.devices)),
            asyncio.create_task(executions.follow(bus, app.state.engine)),  # G-13
            asyncio.create_task(
                relay.follow(bus, app.state.hub, app.state.devices, app.state.history)
            ),
        ]
        try:
            await relay.start(bus, app.state.hub, app.state.devices, app.state.scenes)
            yield
        finally:
            for task in tasks:
                task.cancel()
                with suppress(asyncio.CancelledError):
                    await task
            await bus.close()
            await app.state.go2rtc.aclose()
            await app.state.llm_gateway.aclose()
            await app.state.engine.dispose()

    # 关闭自带文档页：其页面从公网 CDN 加载脚本（G-05）
    app = FastAPI(lifespan=lifespan, openapi_url=None, docs_url=None, redoc_url=None)
    app.add_middleware(RequestIdMiddleware)
    app.add_exception_handler(HTTPException, on_http_error)
    app.add_exception_handler(RequestValidationError, on_validation_error)
    app.state.config = config
    app.state.site = site.load(config.site_file)
    app.state.hub = ws.Hub()
    app.state.devices = Devices(app.state.site.devices)
    app.state.scenes = {}
    app.state.history = History()
    app.include_router(auth.router)
    app.include_router(audit.router)
    app.include_router(containment.router)
    app.include_router(llm.router)
    app.include_router(llm_probe.router)
    app.include_router(reports.router)
    app.include_router(site.router)
    app.include_router(ws.router)
    app.include_router(video.router)

    @app.get("/healthz", status_code=204)
    async def healthz() -> Response:
        """容器健康检查：数据库可达即就绪。不经 web-console 代理，不属于对外接口。"""
        async with app.state.engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
        return Response(status_code=204)

    return app
