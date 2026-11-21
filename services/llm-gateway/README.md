# llm-gateway

LLM 接入网关（architecture.md §5），系统中唯一访问模型供应商的组件（C-LLM-01）。实现测试连接与模型列表（TK-060，设计 `060-llm-providers.md`）与调用链（TK-062，设计 `062-llm-call-chain.md`）。

## 职责

- 内部接口只在 `llm-net`（只有 api-server 与网关接入），由 api-server 调用，不经 web-console 代理；请求体带已解密的 Key，不写日志（C-LLM-15）
  - `POST /internal/probe`：依次检查连通与延迟（`GET <地址>/models`）、模型是否在列表中、结构化输出能力（先 `json_schema` 再 `json_object`，剥离 `<think>` 段后本地校验，C-LLM-12），返回分项结果、健康分档（`ok` / `slow` / `failed`，连通延迟超过 3000 ms 为 `slow`）与探测到的能力
  - `POST /internal/models`：模型列表，兼容 `data[].id` 与 `models[]`，去重排序；出错时 502，消息为"原因；改法"
  - `POST /internal/invoke`：调用方给出事件等级且任务配置了 `routing` 时先路由——`escalate` 内的等级（现为 critical）升阶，公网（云端）供应商优先，其余等级内网（本地）优先，同一网络位置内保持管理员排定的先后；首选不可达或超时即转下一家（云端不可用时降级回本地），全部不可用由调用方落模板或规则结论。全局禁止公网开启时（`block_public`），标为公网、解析不出或实际指向公网地址的供应商一律跳过、不发请求；未开启时实际指向公网的供应商即使标为内网也按公网脱敏（`egress.py`）。随后按 api-server 转交的已启用供应商顺序逐个尝试任务（`deploy/configs/llm-tasks.yaml`）：证据以随机标记包裹（C-LLM-08），公网供应商先脱敏、输出再还原（C-LLM-03），剥离 `<think>` 段后本地校验、失败重试 1 次（C-LLM-05、C-LLM-12），成功后做事实回溯并返回未溯源实体（C-LLM-06、D-086）；连续失败 4 次的供应商 60 s 内跳过（熔断只在内存中）；全部尝试受任务总时限约束（调用方可传更短的剩余时间）。返回输出与每次尝试的结果，审计与用量由 api-server 写库。值班员任务 `incident_investigation` 每次调用只做一轮（调用工具或判定），循环与只读工具在 api-server（D-087），回溯依据取调用方传入的 `evidence`
- 失败给出白话原因与改法（D-084）：Key 无效、误填 `127.0.0.1`（DP-07）、超时、限流、跳转不跟随（C-LLM-14）、非兼容格式；`/models` 返回 404 时补上 `/v1` 再试，可用则返回建议地址；模型不在列表时给出至多 3 个相近候选
- 只用官方 `openai` SDK，不重试、不跟随跳转；Prompt 取自 `prompts/`（C-LLM-07）
- 出站经 `llm-egress` 网络，`host.docker.internal` 指向宿主（DP-05 例外、DP-07）

## 配置项

见 `src/llm_gateway/app.py` 的 `GatewayConfig`，环境变量前缀 `HYD_`。
