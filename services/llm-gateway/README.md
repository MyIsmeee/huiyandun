# llm-gateway

LLM 接入网关（HYD-ARCH-001 §5），系统中唯一访问模型供应商的组件（C-LLM-01）。目前实现模型列表（TK-060，设计 `060-llm-providers.md`）；调用链与故障转移由 TK-062 实现。

## 职责

- 内部接口只在 `llm-net`（只有 api-server 与网关接入），由 api-server 调用，不经 web-console 代理；请求体带已解密的 Key，不写日志（C-LLM-15）
  - `POST /internal/models`：模型列表，兼容 `data[].id` 与 `models[]`，去重排序；出错时 502，消息为"原因；改法"
- 失败给出白话原因与改法（D-084）：Key 无效、误填 `127.0.0.1`（DP-07）、超时、限流、跳转不跟随（C-LLM-14）、非兼容格式；`/models` 返回 404 时补上 `/v1` 再试，可用则返回建议地址
- 只用官方 `openai` SDK，不重试、不跟随跳转
- 出站经 `llm-egress` 网络，`host.docker.internal` 指向宿主（DP-05 例外、DP-07）

## 配置项

见 `src/llm_gateway/app.py` 的 `GatewayConfig`，环境变量前缀 `HYD_`。
