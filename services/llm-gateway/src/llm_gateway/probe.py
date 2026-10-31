"""测试连接（FR-602、TK-060）：依次检查连通与延迟、模型是否存在、结构化输出能力。

健康分档借鉴 cc-switch 的 stream_check（D-084）：连通或模型不通过为 failed，连通延迟超过 3000 ms 为 slow。
"""

import difflib
import re
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

import httpx2
from openai import APIConnectionError, APIStatusError, BadRequestError, UnprocessableEntityError
from pydantic import BaseModel, ConfigDict, ValidationError

from llm_gateway.connect import ProbeFailure, Target, client, explain, list_models
from py_contracts.api import ProviderCheck, ProviderTestResult

SLOW_MS = 3000  # 连通延迟超过即为 slow
PROBE_SCHEMA = {
    "type": "object",
    "properties": {"ok": {"type": "boolean"}},
    "required": ["ok"],
    "additionalProperties": False,
}
RESPONSE_FORMATS: list[tuple[Literal["json_schema", "json_object"], dict[str, Any]]] = [
    (
        "json_schema",
        {
            "type": "json_schema",
            "json_schema": {"name": "probe", "schema": PROBE_SCHEMA, "strict": True},
        },
    ),
    ("json_object", {"type": "json_object"}),
]
THINK = re.compile(r"<think>.*?</think>", re.DOTALL)
NOT_CHECKED = "未检查：前一项未通过"


class ProbeReply(BaseModel):
    model_config = ConfigDict(extra="forbid")
    ok: bool


def strip_reasoning(content: str) -> str:
    """C-LLM-12：只校验最终内容；reasoning_content 是单独字段，本就不读。"""
    return THINK.sub("", content).strip()


async def _structured_output(
    target: Target, prompt: str, transport: httpx2.AsyncBaseTransport | None
) -> tuple[ProviderCheck, Literal["json_schema", "json_object", "none"] | None]:
    async with client(target, transport) as c:
        for name, response_format in RESPONSE_FORMATS:
            started = time.monotonic()
            try:
                completion = await c.chat.completions.create(
                    model=target.model or "",
                    messages=[{"role": "user", "content": prompt}],
                    response_format=response_format,
                    temperature=0,
                )
                content = completion.choices[0].message.content if completion.choices else None
                ProbeReply.model_validate_json(strip_reasoning(content or ""))
            except (BadRequestError, UnprocessableEntityError, ValidationError):
                continue  # 不支持该格式，或输出为空、不合 Schema：试下一种
            except (APIConnectionError, APIStatusError) as e:
                failure = explain(e, target)
                return _check("structured_output", False, None, failure.reason, failure.hint), None
            latency = int((time.monotonic() - started) * 1000)
            return _check("structured_output", True, latency, None, None), name
    return (
        _check(
            "structured_output",
            False,
            None,
            "不支持 json_schema 与 json_object 结构化输出",
            "仍可使用：网关按普通文本调用并在本地校验输出",
        ),
        "none",
    )


def _check(
    check: str, ok: bool, latency_ms: int | None, reason: str | None, hint: str | None
) -> ProviderCheck:
    return ProviderCheck.model_validate(
        {"check": check, "ok": ok, "latency_ms": latency_ms, "reason": reason, "hint": hint}
    )


def _skipped(check: str) -> ProviderCheck:
    return _check(check, False, None, NOT_CHECKED, None)


async def probe(
    target: Target, prompts_dir: Path, transport: httpx2.AsyncBaseTransport | None = None
) -> tuple[ProviderTestResult, Literal["json_schema", "json_object", "none"] | None]:
    """返回分项结果与探测到的结构化输出能力（未探测到时为 None）。"""
    result: dict[str, Any] = {
        "tested_at": datetime.now(UTC),
        "suggested_base_url": None,
        "suggested_models": [],
        "health": "failed",
    }
    started = time.monotonic()
    try:
        models = await list_models(target, transport)
    except ProbeFailure as f:
        connectivity = _check("connectivity", False, None, f.reason, f.hint)
        result |= {"suggested_base_url": f.suggested_base_url}
        checks = [connectivity, _skipped("model"), _skipped("structured_output")]
        return ProviderTestResult.model_validate(result | {"checks": checks}), None
    latency = int((time.monotonic() - started) * 1000)
    connectivity = _check("connectivity", True, latency, None, None)

    if target.model not in models:
        lowered = {m.lower(): m for m in models}
        close = difflib.get_close_matches((target.model or "").lower(), lowered, n=3, cutoff=0.4)
        suggested = [lowered[m] for m in close]
        model = _check(
            "model",
            False,
            None,
            f"模型 {target.model} 不在供应商的模型列表中",
            f"可改选：{'、'.join(suggested)}" if suggested else "点击“获取列表”从中选择",
        )
        result |= {"suggested_models": suggested}
        checks = [connectivity, model, _skipped("structured_output")]
        return ProviderTestResult.model_validate(result | {"checks": checks}), None

    prompt = (prompts_dir / "provider_probe/v1.md").read_text(encoding="utf-8")
    structured, capability = await _structured_output(target, prompt, transport)
    checks = [connectivity, _check("model", True, None, None, None), structured]
    health = "slow" if latency > SLOW_MS else "ok"
    return ProviderTestResult.model_validate(
        result | {"checks": checks, "health": health}
    ), capability
