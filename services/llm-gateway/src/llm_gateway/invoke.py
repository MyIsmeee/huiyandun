"""调用链（HYD-ARCH-001 §5.1、TK-062）：按供应商顺序逐个尝试，全部失败时由调用方执行任务的 terminal。

每家：熔断检查 → 公网脱敏（C-LLM-03）→ 调用 → 剥离推理内容（C-LLM-12）→ 本地 Schema 校验，失败重试 1 次
（C-LLM-05）→ 还原假名；成功后做事实回溯，未溯源实体随输出返回（C-LLM-06、D-086）。
熔断借鉴 cc-switch（D-084）：连续失败 4 次的供应商 60 s 内跳过，到期后放行一次，成功即清零。
"""

import json
import logging
import secrets
import time
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path
from string import Template
from typing import Any, Literal

import httpx2
import yaml
from openai import APIConnectionError, APIResponseValidationError, APIStatusError
from openai.types.chat import ChatCompletion, ChatCompletionMessageParam
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from llm_gateway.connect import Target, client, explain
from llm_gateway.probe import strip_reasoning
from llm_gateway.redact import Pseudonyms, untraced
from py_contracts.llm.incident_report_v1_schema import IncidentReport

log = logging.getLogger(__name__)

FAILURES, COOLDOWN = 4, timedelta(seconds=60)
CONNECT_S = 2.0  # 连不上即转下一家，全部不可用时尽快落模板（FR-502）
NOT_COMPATIBLE = "返回的不是 OpenAI 兼容格式"
SCHEMAS: dict[str, type[BaseModel]] = {
    "contracts/llm/incident_report.v1.schema.json": IncidentReport,
}


class Task(BaseModel):
    """deploy/configs/llm-tasks.yaml 中的一项（HYD-ARCH-001 §5.3）。"""

    model_config = ConfigDict(extra="forbid")
    schema_: str = Field(alias="schema")
    prompt: str
    temperature: float
    deadline_s: float
    terminal: Literal["rule-only", "template-only"]

    @field_validator("schema_")
    @classmethod
    def _known(cls, value: str) -> str:
        if value not in SCHEMAS:
            raise ValueError(f"{value} 没有对应的生成模型")
        return value


def load_tasks(path: Path) -> dict[str, Task]:
    return {
        name: Task.model_validate(spec)
        for name, spec in yaml.safe_load(path.read_text(encoding="utf-8")).items()
    }


class Provider(Target):
    """api-server 转交的已启用供应商，按故障转移顺序排列。"""

    id: str
    name: str
    model: str
    network: Literal["internal", "public"]
    structured_output: Literal["json_schema", "json_object", "none"] | None


class Invocation(BaseModel):
    """data 为结构化证据，只有 JSON：契约中没有图像、视频帧、pcap（C-LLM-04）。"""

    model_config = ConfigDict(extra="forbid")
    task: str
    data: dict[str, Any]
    providers: list[Provider]


class Attempt(BaseModel):
    provider_id: str
    outcome: Literal["ok", "failed", "skipped"]
    reason: str | None
    latency_ms: int | None
    tokens: int
    redacted: bool


class InvokeResult(BaseModel):
    output: dict[str, Any] | None
    unverified: list[str]
    provider_id: str | None
    attempts: list[Attempt]


class Breaker:
    def __init__(self, clock: Callable[[], datetime] = lambda: datetime.now(UTC)) -> None:
        self._clock = clock
        self._failures: dict[str, int] = {}
        self._until: dict[str, datetime] = {}

    def blocked_until(self, provider_id: str) -> datetime | None:
        until = self._until.get(provider_id)
        return until if until is not None and until > self._clock() else None

    def record(self, provider_id: str, ok: bool) -> None:
        if ok:
            self._failures.pop(provider_id, None)
            self._until.pop(provider_id, None)
            return
        self._failures[provider_id] = self._failures.get(provider_id, 0) + 1
        if self._failures[provider_id] >= FAILURES:
            self._until[provider_id] = self._clock() + COOLDOWN


class CallFailed(Exception):
    def __init__(self, reason: str, tokens: int) -> None:
        super().__init__(reason)
        self.reason, self.tokens = reason, tokens


class Chain:
    def __init__(
        self,
        tasks: dict[str, Task],
        prompts_dir: Path,
        techniques: set[str],
        transport: httpx2.AsyncBaseTransport | None = None,
    ) -> None:
        self.tasks, self._techniques, self._transport = tasks, techniques, transport
        self._prompts = {
            name: (prompts_dir / t.prompt).read_text("utf-8") for name, t in tasks.items()
        }
        self._wrapper = (prompts_dir / "untrusted_data/v1.md").read_text("utf-8")
        self.breaker = Breaker()

    def _messages(self, name: str, data: Any) -> list[ChatCompletionMessageParam]:
        """C-LLM-08：每次调用新生成随机串作包裹标记，数据中无法伪造结束标记。"""
        nonce = secrets.token_hex(8)
        schema = json.dumps(
            SCHEMAS[self.tasks[name].schema_].model_json_schema(), ensure_ascii=False
        )
        data_text = json.dumps(data, ensure_ascii=False, indent=1)
        return [
            {
                "role": "system",
                "content": Template(self._prompts[name]).substitute(nonce=nonce, schema=schema),
            },
            {
                "role": "user",
                "content": Template(self._wrapper).substitute(nonce=nonce, data=data_text),
            },
        ]

    async def _call(
        self,
        name: str,
        provider: Provider,
        messages: list[ChatCompletionMessageParam],
        deadline: float,
        restore: Callable[[Any], Any],
    ) -> tuple[dict[str, Any], int]:
        """restore 把公网供应商输出中的假名换回原值；校验的是还原后的输出，即实际存下的内容（G-12）。"""
        task = self.tasks[name]
        model = SCHEMAS[task.schema_]
        extra: dict[str, Any] = {}
        if provider.structured_output == "json_schema":
            schema = {"name": name, "schema": model.model_json_schema()}
            extra["response_format"] = {"type": "json_schema", "json_schema": schema}
        elif provider.structured_output == "json_object":
            extra["response_format"] = {"type": "json_object"}
        tokens = 0
        async with client(provider, self._transport) as c:
            for _ in range(2):  # 校验失败重试 1 次（C-LLM-05）
                remaining = min(provider.timeout_s, deadline - time.monotonic())
                if remaining <= 0:
                    raise CallFailed(f"超出 {task.deadline_s:g} 秒总时限", tokens)
                try:
                    completion = await c.chat.completions.create(
                        model=provider.model,
                        messages=messages,
                        temperature=task.temperature,
                        timeout=httpx2.Timeout(remaining, connect=min(CONNECT_S, remaining)),
                        **extra,
                    )
                except (APIConnectionError, APIStatusError) as e:
                    raise CallFailed(explain(e, provider).reason, tokens) from e
                except (APIResponseValidationError, ValueError) as e:  # 200 但响应体不是 JSON
                    raise CallFailed(NOT_COMPATIBLE, tokens) from e
                if not isinstance(completion, ChatCompletion):  # 非 JSON 的 200，SDK 原样返回文本
                    raise CallFailed(NOT_COMPATIBLE, tokens)
                try:  # SDK 不严格校验响应结构：JSON 字段对不上时取值即抛异常
                    tokens += getattr(completion.usage, "total_tokens", None) or 0
                    message = completion.choices[0].message if completion.choices else None
                    text = strip_reasoning(getattr(message, "content", None) or "")
                except (AttributeError, TypeError, IndexError) as e:
                    raise CallFailed(NOT_COMPATIBLE, tokens) from e
                try:
                    # 假名换回原值后可能超出长度上限，按不合格式重试
                    reply = model.model_validate(restore(json.loads(text)))
                except (ValueError, ValidationError):
                    continue
                return reply.model_dump(mode="json"), tokens
        raise CallFailed("输出两次不符合格式", tokens)

    async def invoke(self, req: Invocation) -> InvokeResult:
        task = self.tasks[req.task]
        deadline = time.monotonic() + task.deadline_s
        attempts: list[Attempt] = []
        for provider in req.providers:
            pseudonyms = Pseudonyms() if provider.network == "public" else None
            skipped = None
            if deadline <= time.monotonic():
                skipped = f"超出 {task.deadline_s:g} 秒总时限"
            elif (until := self.breaker.blocked_until(provider.id)) is not None:
                skipped = f"连续失败 {FAILURES} 次，暂停调用至 {until:%H:%M:%S} UTC"
            if skipped:
                attempts.append(_attempt(req.task, provider, "skipped", skipped, None, 0, False))
                continue
            data = pseudonyms.redact(req.data) if pseudonyms else req.data
            messages = self._messages(req.task, data)
            started = time.monotonic()
            try:
                output, tokens = await self._call(
                    req.task,
                    provider,
                    messages,
                    deadline,
                    pseudonyms.restore if pseudonyms else _same,
                )
            except CallFailed as f:
                self.breaker.record(provider.id, ok=False)
                latency = int((time.monotonic() - started) * 1000)
                attempts.append(
                    _attempt(
                        req.task, provider, "failed", f.reason, latency, f.tokens, bool(pseudonyms)
                    )
                )
                continue
            self.breaker.record(provider.id, ok=True)
            latency = int((time.monotonic() - started) * 1000)
            attempts.append(
                _attempt(req.task, provider, "ok", None, latency, tokens, bool(pseudonyms))
            )
            return InvokeResult(
                output=output,
                unverified=untraced(output, req.data, self._techniques),
                provider_id=provider.id,
                attempts=attempts,
            )
        return InvokeResult(output=None, unverified=[], provider_id=None, attempts=attempts)


def _same(value: Any) -> Any:
    return value


def _attempt(
    task: str,
    provider: Provider,
    outcome: Literal["ok", "failed", "skipped"],
    reason: str | None,
    latency_ms: int | None,
    tokens: int,
    redacted: bool,
) -> Attempt:
    """每次尝试写一行日志：不含证据、输出与 Key（C-LLM-15）。"""
    attempt = Attempt(
        provider_id=provider.id,
        outcome=outcome,
        reason=reason,
        latency_ms=latency_ms,
        tokens=tokens,
        redacted=redacted,
    )
    log.info("llm.attempt", extra={"task": task} | attempt.model_dump())
    return attempt
