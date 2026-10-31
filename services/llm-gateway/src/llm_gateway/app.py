"""llm-gateway 内部接口：只在 core-net，供 api-server 调用，不经 web-console 代理（C-LLM-01）。

请求体含已解密的 Key，不写日志（C-LLM-15）。
"""

import httpx2
import uvicorn
from fastapi import FastAPI, Response
from fastapi.responses import JSONResponse
from pydantic import Field

from llm_gateway.connect import ProbeFailure, Target, list_models
from py_common.config import ServiceConfig, load_config
from py_common.log import configure_logging
from py_contracts.api import ModelList


class GatewayConfig(ServiceConfig):
    port: int = Field(8100, ge=1, le=65535, description="内部 HTTP 监听端口，只在 core-net")


def create_app(
    config: GatewayConfig, transport: httpx2.AsyncBaseTransport | None = None
) -> FastAPI:
    """transport 仅供测试注入录制响应。"""
    app = FastAPI(openapi_url=None, docs_url=None, redoc_url=None)

    @app.post("/internal/models", response_model=ModelList)
    async def models(target: Target) -> ModelList | JSONResponse:
        try:
            return ModelList(models=await list_models(target, transport))
        except ProbeFailure as f:
            return JSONResponse({"message": f"{f.reason}；{f.hint}"}, status_code=502)

    @app.get("/healthz", status_code=204)
    async def healthz() -> Response:
        return Response(status_code=204)

    return app


def main() -> None:
    config = load_config(GatewayConfig)
    configure_logging("llm-gateway", config.log_level)
    # log_config=None：uvicorn 的日志沿用根 logger 的 JSON 格式（CD-06）
    uvicorn.run(create_app(config), host="0.0.0.0", port=config.port, log_config=None)
