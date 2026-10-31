"""llm-gateway 内部接口（FR-602、V-M6、TK-060、D-084）：模型列表、失败解释、测试连接。

以 httpx2 MockTransport 回放录制的响应模拟供应商，用例不访问真实端点。
"""

import json
from collections.abc import Callable
from pathlib import Path

import httpx2
import pytest
from fastapi.testclient import TestClient

from llm_gateway.app import GatewayConfig, create_app

PROMPTS = Path(__file__).resolve().parents[3] / "prompts"
KEY = "sk-not-a-real-key-7f3a"
BASE = "http://192.168.1.50:8888/v1"
MODELS = {"object": "list", "data": [{"id": "qwen3-8b"}, {"id": "deepseek-chat"}]}

Handler = Callable[[httpx2.Request], httpx2.Response]


def completion(content: str) -> httpx2.Response:
    """录制自 llama.cpp 的 /v1/chat/completions 响应（截去用量字段）。"""
    return httpx2.Response(
        200,
        json={
            "id": "chatcmpl-1",
            "object": "chat.completion",
            "created": 1761980000,
            "model": "qwen3-8b",
            "choices": [
                {
                    "index": 0,
                    "finish_reason": "stop",
                    "message": {"role": "assistant", "content": content},
                }
            ],
        },
    )


class Provider:
    """模拟供应商：/models 与 /chat/completions 可分别替换；seen 为收到的请求。"""

    KEY, BASE, MODELS = KEY, BASE, MODELS
    completion = staticmethod(completion)

    def __init__(self) -> None:
        self.seen: list[httpx2.Request] = []
        self.models: Handler = lambda _: httpx2.Response(200, json=MODELS)
        self.chat: Handler = lambda _: completion('{"ok": true}')

    def __call__(self, request: httpx2.Request) -> httpx2.Response:
        self.seen.append(request)
        return (self.models if request.url.path.endswith("/models") else self.chat)(request)

    def post(self, path: str, **target: object) -> httpx2.Response:
        app = create_app(GatewayConfig(prompts_dir=PROMPTS), transport=httpx2.MockTransport(self))
        body = {"base_url": BASE, "api_key": KEY, "model": "qwen3-8b", "timeout_s": 5} | target
        with TestClient(app) as c:
            return c.post(path, json=body)


@pytest.fixture
def provider() -> Provider:
    return Provider()


# 模型列表与失败解释


def message(provider: Provider, **target: object) -> str:
    r = provider.post("/internal/models", **target)
    assert r.status_code == 502
    return r.json()["message"]


def test_models_listed_with_key(provider: Provider) -> None:
    r = provider.post("/internal/models")
    assert r.json() == {"models": ["deepseek-chat", "qwen3-8b"]}
    assert provider.seen[0].headers["authorization"] == f"Bearer {provider.KEY}"


def test_model_list_variants_deduplicated_and_sorted(provider: Provider) -> None:
    variants = {"models": [{"name": "qwen2.5:7b"}, {"model": "llama3"}, {"name": "qwen2.5:7b"}]}
    provider.models = lambda _: httpx2.Response(200, json=variants)
    assert provider.post("/internal/models").json() == {"models": ["llama3", "qwen2.5:7b"]}


def test_unauthorized_explained(provider: Provider) -> None:
    provider.models = lambda _: httpx2.Response(401, json={"error": "invalid key"})
    text = message(provider)
    assert text.startswith("API Key 无效或无权限（HTTP 401）；重新填写 Key")
    assert provider.KEY not in text


@pytest.mark.parametrize(
    ("status", "expected"),
    [
        (429, "请求过于频繁或额度不足（HTTP 429）；稍后重试，或检查账户余额"),
        (503, "供应商服务异常（HTTP 503）；稍后重试"),
        (400, "请求被拒绝（HTTP 400）；核对地址与模型名"),
    ],
)
def test_other_status_explained(provider: Provider, status: int, expected: str) -> None:
    provider.models = lambda _: httpx2.Response(status, json={"error": "x"})
    assert message(provider) == expected


def test_timeout_explained(provider: Provider) -> None:
    def slow(request: httpx2.Request) -> httpx2.Response:
        raise httpx2.ReadTimeout("timed out", request=request)

    provider.models = slow
    assert message(provider, timeout_s=3).startswith("3 秒内无响应；")


@pytest.mark.parametrize(
    ("base_url", "hint"),
    [("http://127.0.0.1:8080/v1", "host.docker.internal"), (Provider.BASE, "监听 0.0.0.0")],
)
def test_connection_refused_hints_loopback(provider: Provider, base_url: str, hint: str) -> None:
    """DP-07：容器内 127.0.0.1 指向网关自身。"""

    def refused(request: httpx2.Request) -> httpx2.Response:
        raise httpx2.ConnectError("connection refused", request=request)

    provider.models = refused
    assert hint in message(provider, base_url=base_url)


def test_missing_v1_suggests_corrected_url(provider: Provider) -> None:
    """D-084：/models 返回 404 时补上 /v1 再试，可用即给出建议地址，不静默改写。"""
    provider.models = lambda r: httpx2.Response(
        200 if r.url.path == "/v1/models" else 404, json=Provider.MODELS
    )
    assert "改为 http://192.168.1.50:8888/v1" in message(
        provider, base_url="http://192.168.1.50:8888"
    )


def test_cross_host_redirect_not_followed(provider: Provider) -> None:
    """C-LLM-14：跳转不跟随，也不向跳转目标发请求。"""
    location = "https://elsewhere.example/v1/models"
    provider.models = lambda _: httpx2.Response(302, headers={"location": location})
    text = message(provider)
    assert "不跟随" in text and location in text
    assert {r.url.host for r in provider.seen} == {"192.168.1.50"}


def test_non_openai_response_explained(provider: Provider) -> None:
    provider.models = lambda _: httpx2.Response(200, json={"hello": "world"})
    assert message(provider).startswith("返回的不是 OpenAI 兼容格式；")


# 测试连接：分项结果、健康分档、结构化输出探测


def checks(response: httpx2.Response) -> dict[str, dict]:
    return {c["check"]: c for c in response.json()["result"]["checks"]}


def test_all_checks_pass_and_json_schema_detected(provider: Provider) -> None:
    r = provider.post("/internal/probe")
    result = r.json()["result"]
    assert result["health"] == "ok"
    assert all(c["ok"] for c in result["checks"])
    assert checks(r)["connectivity"]["latency_ms"] is not None
    assert r.json()["structured_output"] == "json_schema"
    assert json.loads(provider.seen[1].content)["response_format"]["type"] == "json_schema"
    assert provider.KEY not in r.text


def test_connectivity_failure_skips_rest(provider: Provider) -> None:
    provider.models = lambda _: httpx2.Response(401)
    r = provider.post("/internal/probe")
    assert r.json()["result"]["health"] == "failed"
    assert "API Key 无效" in checks(r)["connectivity"]["reason"]
    assert checks(r)["model"]["reason"].startswith("未检查")
    assert r.json()["structured_output"] is None


def test_missing_v1_returned_as_suggested_base_url(provider: Provider) -> None:
    provider.models = lambda r: (
        httpx2.Response(200, json={"data": []})
        if r.url.path == "/v1/models"
        else httpx2.Response(404)
    )
    r = provider.post("/internal/probe", base_url="http://192.168.1.50:8888")
    assert r.json()["result"]["suggested_base_url"] == "http://192.168.1.50:8888/v1"


def test_unknown_model_suggests_close_names(provider: Provider) -> None:
    r = provider.post("/internal/probe", model="Qwen3-8B-Instruct")
    model = checks(r)["model"]
    assert model["ok"] is False
    assert r.json()["result"]["suggested_models"][0] == "qwen3-8b"
    assert "可改选：qwen3-8b" in model["hint"]
    assert r.json()["result"]["health"] == "failed"


def test_json_schema_rejected_falls_back_to_json_object(provider: Provider) -> None:
    def chat(request: httpx2.Request) -> httpx2.Response:
        if json.loads(request.content)["response_format"]["type"] == "json_schema":
            return httpx2.Response(400, json={"error": "response_format not supported"})
        return provider.completion('{"ok": true}')

    provider.chat = chat
    r = provider.post("/internal/probe")
    assert checks(r)["structured_output"]["ok"] is True
    assert r.json()["structured_output"] == "json_object"


def test_no_structured_output_still_healthy(provider: Provider) -> None:
    """不支持结构化输出：该项不通过并说明仍可用，不影响健康分档。"""
    provider.chat = lambda _: provider.completion("好的，这是结果：ok")
    r = provider.post("/internal/probe")
    structured = checks(r)["structured_output"]
    assert structured["ok"] is False and "仍可使用" in structured["hint"]
    assert r.json()["structured_output"] == "none"
    assert r.json()["result"]["health"] == "ok"


def test_think_segment_stripped_before_validation(provider: Provider) -> None:
    """C-LLM-12：推理模型先输出 <think> 段。"""
    provider.chat = lambda _: provider.completion('<think>先想想</think>\n{"ok": true}')
    assert provider.post("/internal/probe").json()["structured_output"] == "json_schema"


def test_structured_output_timeout_keeps_capability_unknown(provider: Provider) -> None:
    def slow(request: httpx2.Request) -> httpx2.Response:
        raise httpx2.ReadTimeout("timed out", request=request)

    provider.chat = slow
    r = provider.post("/internal/probe")
    assert checks(r)["structured_output"]["reason"] == "5 秒内无响应"
    assert r.json()["structured_output"] is None
