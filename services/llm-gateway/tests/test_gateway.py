"""llm-gateway 内部接口（FR-602、V-M6、TK-060、D-084）：模型列表与失败解释。

以 httpx2 MockTransport 回放录制的响应模拟供应商，用例不访问真实端点。
"""

from collections.abc import Callable

import httpx2
import pytest
from fastapi.testclient import TestClient

from llm_gateway.app import GatewayConfig, create_app

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
        app = create_app(GatewayConfig(), transport=httpx2.MockTransport(self))
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
