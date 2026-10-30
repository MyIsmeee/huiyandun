# playbook-executor

确定性处置执行器（HYD-ARCH-001 §4、设计 `docs/design/050-containment.md`）：关联事件满足 Playbook 条件时，经 privileged-helper 封禁攻击源，到 TTL 自动解除。不 import 任何 LLM 客户端，处置参数只取关联事件的结构化字段（G-03、D-01）。

## 职责

- Playbook（`playbooks.py`）：`playbooks/<ID>.yaml` 按 HYD-PLAN-007 §5 加载与校验，目标只能取 `incident.source_ip`
- 编排（`executor.py`）：只处理 `enforce` 的关联事件（D-068）；部署模式不支持时只通知（FR-1001）；没有攻击源、未配置白名单或目标在白名单内时跳过并写明原因（FR-403）；同一目标互斥（C-BE-04）；含模型证据时等待确认，30 分钟未确认即过期（FR-407、D-073）；precheck → execute → verify，失败回滚已执行部分（FR-406）；确认规则生效即 `contained`，30 s 内读拦截计数写明证据（D-072）；TTL 到期或手动回滚后 `rolled_back`（FR-404、FR-405）
- 动作（`nftables.py`）：`block_ip` 经 privileged-helper 的签名指令封禁、读计数、解封
- 服务（`service.py`）：每次状态变化发布 `hyd.playbook.execution.v1`（流 `HYD_PLAYBOOK`）；订阅关联事件、确认（`hyd.correlator.confirmation.v1`）与手动回滚（`hyd.playbook.rollback.v1`），后两者的流 `HYD_COMMAND` 由本服务创建。重启时先重放近 24 小时的执行记录：已生效的继续计时，执行到一半的撤销并记为失败

## 配置项

见 `src/playbook_executor/service.py` 的 `ExecutorConfig`，环境变量前缀 `HYD_`。`HYD_TTL_OVERRIDE_S` 覆盖全部 Playbook 的 TTL，主剧本为 150（FR-404）。

## 测试

```sh
uv run pytest services/playbook-executor
```
