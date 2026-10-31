"""连接供应商、解释失败原因、获取模型列表（V-M6、TK-060）。

失败给出白话原因与改法（D-084，借鉴 cc-switch 的 error_mapper 与 model_fetch）。只用官方 openai SDK，
不重试、不跟随跳转（C-LLM-14）；Key 不进入原因、改法与日志（C-LLM-15）。
"""

from ipaddress import ip_address
from urllib.parse import urlsplit

import httpx2
from openai import APIConnectionError, APIStatusError, APITimeoutError, AsyncOpenAI
from pydantic import BaseModel, ConfigDict, SecretStr


class Target(BaseModel):
    """api-server 转交的供应商配置；Key 已解密，只在内存中使用。"""

    model_config = ConfigDict(extra="forbid")
    base_url: str
    api_key: SecretStr | None = None
    model: str | None = None
    timeout_s: float


class ProbeFailure(Exception):
    def __init__(
        self,
        reason: str,
        hint: str,
        *,
        status: int | None = None,
        suggested_base_url: str | None = None,
    ) -> None:
        super().__init__(reason)
        self.reason, self.hint, self.status = reason, hint, status
        self.suggested_base_url = suggested_base_url


def _is_loopback(host: str) -> bool:
    if host == "localhost":
        return True
    try:
        return ip_address(host).is_loopback
    except ValueError:
        return False


def explain(e: APIConnectionError | APIStatusError, target: Target) -> ProbeFailure:
    url = urlsplit(target.base_url)
    host = f"{url.hostname}:{url.port or (443 if url.scheme == 'https' else 80)}"
    if isinstance(e, APITimeoutError):
        return ProbeFailure(f"{target.timeout_s:g} 秒内无响应", "确认地址可达，或调大超时")
    if isinstance(e, APIConnectionError):
        if _is_loopback(url.hostname or ""):
            return ProbeFailure(
                f"无法连接到 {host}",
                "容器内这个地址指向网关自身：改填本机局域网 IP 或 host.docker.internal（DP-07）",
            )
        return ProbeFailure(
            f"无法连接到 {host}",
            "确认模型服务已启动并监听 0.0.0.0（而非 127.0.0.1），防火墙放行该端口",
        )
    code = e.status_code
    if code in (401, 403):
        reason, hint = (
            f"API Key 无效或无权限（HTTP {code}）",
            "重新填写 Key；本地服务未设 Key 时留空",
        )
    elif code == 404:
        reason, hint = "地址路径不对（HTTP 404）", "核对是否为 OpenAI 兼容地址，通常以 /v1 结尾"
    elif code == 429:
        reason, hint = "请求过于频繁或额度不足（HTTP 429）", "稍后重试，或检查账户余额"
    elif 300 <= code < 400:
        location = e.response.headers.get("location")
        reason = f"地址发生跳转（HTTP {code}），为安全起见不跟随"
        hint = f"直接填写跳转后的地址：{location}" if location else "直接填写跳转后的地址"
    elif code >= 500:
        reason, hint = f"供应商服务异常（HTTP {code}）", "稍后重试"
    else:
        reason, hint = f"请求被拒绝（HTTP {code}）", "核对地址与模型名"
    return ProbeFailure(reason, hint, status=code)


def client(target: Target, transport: httpx2.AsyncBaseTransport | None) -> AsyncOpenAI:
    key = target.api_key.get_secret_value() if target.api_key else ""
    return AsyncOpenAI(
        base_url=target.base_url,
        api_key=key or "none",  # SDK 要求非空；本地服务未设 Key 时忽略该请求头
        timeout=target.timeout_s,
        max_retries=0,
        http_client=httpx2.AsyncClient(transport=transport, follow_redirects=False),
    )


def model_ids(data: object) -> list[str]:
    """兼容 data[].id（OpenAI）与 models[] 的 id / name / model。"""
    entries = None
    if isinstance(data, dict):
        entries = data.get("data") if isinstance(data.get("data"), list) else data.get("models")
    if not isinstance(entries, list):
        raise ProbeFailure("返回的不是 OpenAI 兼容格式", "核对地址是否以 /v1 等兼容路径结尾")
    ids = {e.get("id") or e.get("name") or e.get("model") for e in entries if isinstance(e, dict)}
    return sorted(i for i in ids if isinstance(i, str) and i)


async def _get_models(target: Target, transport: httpx2.AsyncBaseTransport | None) -> list[str]:
    async with client(target, transport) as c:
        try:
            return model_ids(await c.get("/models", cast_to=object))
        except (APIConnectionError, APIStatusError) as e:
            raise explain(e, target) from e


async def list_models(
    target: Target, transport: httpx2.AsyncBaseTransport | None = None
) -> list[str]:
    """/models 返回 404 且地址不以 /v1 结尾时，再试补上 /v1 的地址，可用则给出建议地址。"""
    try:
        return await _get_models(target, transport)
    except ProbeFailure as failure:
        if failure.status != 404 or target.base_url.endswith("/v1"):
            raise
        alt = target.model_copy(update={"base_url": f"{target.base_url}/v1"})
        try:
            await _get_models(alt, transport)
        except ProbeFailure:
            raise failure from None
        raise ProbeFailure(
            failure.reason, f"地址缺少 /v1：改为 {alt.base_url}", suggested_base_url=alt.base_url
        ) from None
