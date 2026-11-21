# playbook-executor

确定性处置执行器（architecture.md §4、设计 `docs/archive/design/050-containment.md`）：关联事件满足 Playbook 条件时，经 privileged-helper（主机探针模式）或客户网关上的联动网关（旁路模式）封禁攻击源，到 TTL 自动解除。不 import 任何 LLM 客户端，处置参数只取关联事件的结构化字段（G-03、D-01）。

## 职责

- Playbook（`playbooks.py`）：`playbooks/<ID>.yaml` 按 architecture.md §12 加载与校验，目标只能取 `incident.source_ip`
- 编排（`executor.py`）：只处理 `enforce` 的关联事件（D-068）；同一关联事件可匹配多个 Playbook，按部署模式与已注册的适配器取用可执行的，一个都执行不了时只通知一次并写明原因（FR-1001）；没有攻击源、未配置白名单或目标在白名单内时跳过并写明原因（FR-403）；同一目标互斥（C-BE-04）；含模型证据时等待确认，30 分钟未确认即过期（FR-407、D-073）；precheck → execute → verify，失败回滚已执行部分（FR-406）；确认规则生效即 `contained`，30 s 内读拦截计数写明证据（D-072）；TTL 到期或手动回滚后 `rolled_back`（FR-404、FR-405）
- 动作（`nftables.py`）：`block_ip` 经 privileged-helper 的签名指令封禁、读计数、解封。两个适配器同一协议：
  - `nftables`：本机 Unix 域套接字，封禁作用于边缘主机自身的转发路径（`playbooks/isolate-attacker.yaml`，`host_probe`）
  - `firewall`：TLS 加密的 TCP 连接到联动网关（`playbooks/isolate-attacker-linked.yaml`，`bypass`）。边缘主机只听不发，由流量路径上的客户网关执行封禁；只信任 `HYD_FIREWALL_CA_FILE` 签发的网关证书，未配置 `HYD_FIREWALL_ADDRESS` 时旁路模式只通知
- 服务（`service.py`）：每次状态变化发布 `hyd.playbook.execution.v1`（流 `HYD_PLAYBOOK`）；订阅关联事件、确认（`hyd.correlator.confirmation.v1`）与手动回滚（`hyd.playbook.rollback.v1`），后两者的流 `HYD_COMMAND` 由本服务创建。重启时先重放近 24 小时的执行记录：已生效的继续计时，执行到一半的撤销并记为失败

## 配置项

见 `src/playbook_executor/service.py` 的 `ExecutorConfig`，环境变量前缀 `HYD_`。`HYD_FIREWALL_ADDRESS`（`host:port`）与 `HYD_FIREWALL_CA_FILE` 配置旁路模式的联动网关，须同时设置。`HYD_TTL_OVERRIDE_S` 覆盖全部 Playbook 的 TTL，如演示时缩短封禁时长（FR-404）；未设置时取 Playbook 的 `ttl_s`。

## 测试

```sh
uv run pytest services/playbook-executor
```
