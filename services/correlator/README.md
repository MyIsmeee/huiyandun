# correlator

关联引擎（HYD-ARCH-001 §6）。目前实现归一化器（TK-032）；规则引擎与 Incident 生成由 TK-041 实现。

## 职责

- 读取（`eve.py`）：跟随 Suricata 的 `eve.json`（只读挂载），逐行读取新写入的完整记录。处理到的位置以 (inode, 偏移) 写入 `HYD_STATE_FILE`（持久卷），重启后续读；文件按改名轮转时读完旧文件再读新文件，被截断时从头读
- 归一化（`normalize.py`）：EVE 告警 → `hyd.security.alert.v1`
  - 攻击方与目标取规则 `target` 关键字给出的 `alert.source` / `alert.target`；规则未标明时按报文方向，源即攻击方（#101）
  - 自研规则取 metadata 的 `hyd_rule_id`、`hyd_category`；外部规则的 `rule_id` 为 `SID-<sid>`、类别取 classtype。`rule_version` 为 `rev`
  - `technique` 取 `mitre_technique_id`；缺少时不发布、只记日志（C-SEC-09）
  - 等级：Suricata 优先级 1 → `high`，2 → `medium`，其余 → `low`；`critical` 留给跨域关联事件
  - `device_id`：目标 IP 在 `site.yaml` 中登记的设备，查不到为 null，告警照常发布（FR-203）
  - `event_id` 由 EVE 原文派生，重读同一行时不变，JetStream 据此去重；`evidence_ref` 为 `suricata:flow/<flow_id>`
- 发布（`service.py`）：JetStream 流 `HYD_SECURITY`，保留 365 天（HYD-ARCH-001 §10.2）。服务端确认后才记录位置，发布失败时下个周期重试
- 健康检查：主循环每个周期更新 `HYD_HEARTBEAT_FILE`，10 s 未更新视为卡死

## 配置项

见 `src/correlator/service.py` 的 `CorrelatorConfig`，环境变量前缀 `HYD_`。
