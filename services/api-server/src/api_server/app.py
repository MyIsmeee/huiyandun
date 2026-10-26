"""FastAPI 应用：X-Request-ID 透传（C-BE-08）与统一错误格式（契约 Error）。"""

import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from http import HTTPStatus

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.datastructures import Headers, MutableHeaders
from starlette.exceptions import HTTPException
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from api_server import auth
from api_server.config import ApiConfig
from api_server.db import create_engine
from py_common.log import bind_request_id

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

        async def send_with_id(message: Message) -> None:
            if message["type"] == "http.response.start":
                MutableHeaders(scope=message)["X-Request-ID"] = request_id
            await send(message)

        with bind_request_id(request_id):
            await self.app(scope, receive, send_with_id)


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
    app.include_router(auth.router)
    return app
