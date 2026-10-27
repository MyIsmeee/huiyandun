"""FastAPI 应用：X-Request-ID 透传（C-BE-08）与统一错误格式（契约 Error）。"""

import logging
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from http import HTTPStatus

from fastapi import FastAPI, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from sqlalchemy import text
from starlette.datastructures import Headers, MutableHeaders
from starlette.exceptions import HTTPException
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from api_server import audit, auth, ws
from api_server.config import ApiConfig
from api_server.db import create_engine
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
        app.state.engine = create_engine(config)
        try:
            yield
        finally:
            await app.state.engine.dispose()

    # 关闭自带文档页：其页面从公网 CDN 加载脚本（G-05）
    app = FastAPI(lifespan=lifespan, openapi_url=None, docs_url=None, redoc_url=None)
    app.add_middleware(RequestIdMiddleware)
    app.add_exception_handler(HTTPException, on_http_error)
    app.add_exception_handler(RequestValidationError, on_validation_error)
    app.state.config = config
    app.state.hub = ws.Hub()
    app.include_router(auth.router)
    app.include_router(audit.router)
    app.include_router(ws.router)

    @app.get("/healthz", status_code=204)
    async def healthz() -> Response:
        """容器健康检查：数据库可达即就绪。不经 web-console 代理，不属于对外接口。"""
        async with app.state.engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
        return Response(status_code=204)

    return app
