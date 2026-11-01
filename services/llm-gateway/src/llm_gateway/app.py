"""llm-gateway 内部接口：只在 llm-net，供 api-server 调用，不经 web-console 代理（C-LLM-01）。

请求体含已解密的 Key，不写日志（C-LLM-15）。熔断状态只在内存中，重启即清零（D-084）。
"""

import json
from pathlib import Path
from typing import Literal

import httpx2
import uvicorn
from fastapi import FastAPI, HTTPException, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from llm_gateway.connect import ProbeFailure, Target, list_models
from llm_gateway.invoke import Chain, Invocation, InvokeResult, load_tasks
from llm_gateway.probe import probe
from py_common.config import ServiceConfig, load_config
from py_common.log import configure_logging
from py_contracts.api import ModelList, ProviderTestResult


class GatewayConfig(ServiceConfig):
    port: int = Field(8100, ge=1, le=65535, description="内部 HTTP 监听端口，只在 llm-net")
    prompts_dir: Path = Field(Path("/app/prompts"), description="Prompt 模板目录（C-LLM-07）")
    tasks_file: Path = Field(
        Path("/etc/hyd/llm-tasks.yaml"), description="任务定义 deploy/configs/llm-tasks.yaml"
    )
    attack_file: Path = Field(
        Path("/etc/hyd/attack.json"),
        description="ATT&CK 精简查表 rules/attack/techniques.json，事实回溯的本地知识库（C-LLM-06）",
    )


class ProbeResponse(BaseModel):
    result: ProviderTestResult
    structured_output: Literal["json_schema", "json_object", "none"] | None


def create_app(
    config: GatewayConfig, transport: httpx2.AsyncBaseTransport | None = None
) -> FastAPI:
    """transport 仅供测试注入录制响应。"""
    app = FastAPI(openapi_url=None, docs_url=None, redoc_url=None)
    attack = json.loads(config.attack_file.read_text(encoding="utf-8"))
    chain = Chain(
        load_tasks(config.tasks_file), config.prompts_dir, set(attack["techniques"]), transport
    )

    @app.post("/internal/invoke")
    async def run_invoke(body: Invocation) -> InvokeResult:
        if body.task not in chain.tasks:
            raise HTTPException(422, f"未知任务 {body.task}")
        return await chain.invoke(body)

    @app.post("/internal/probe")
    async def run_probe(target: Target) -> ProbeResponse:
        result, capability = await probe(target, config.prompts_dir, transport)
        return ProbeResponse(result=result, structured_output=capability)

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
