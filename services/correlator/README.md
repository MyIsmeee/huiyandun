# correlator

关联引擎（architecture.md §6）。同一进程里有三部分：归一化器（TK-032）、设备行为模型（TK-115）、规则引擎与关联事件生成（TK-041）。判定只由规则完成，不依赖 LLM（FR-305、G-03）。

## 职责

- 读取（`eve.py`）：跟随 Suricata 的 `eve.json`（只读挂载），逐行读取新写入的完整记录。处理到的位置以 (inode, 偏移) 写入 `HYD_STATE_FILE`（持久卷），重启后续读；文件按改名轮转时读完旧文件再读新文件，被截断时从头读。配置了 `HYD_HOST_EVE_FILE` 时，以同样方式读主机探针（`agents/sensor/host-probe`）输出的同格式告警
- 归一化（`normalize.py`）：EVE 告警 → `hyd.security.alert.v1`
  - 攻击方与目标取规则 `target` 关键字给出的 `alert.source` / `alert.target`；规则未标明时按报文方向，源即攻击方（#101）
  - 自研规则取 metadata 的 `hyd_rule_id`、`hyd_category`；外部规则的 `rule_id` 为 `SID-<sid>`、类别取 classtype。`rule_version` 为 `rev`
  - `technique` 取 `mitre_technique_id`；缺少时不发布、只记日志（C-SEC-09）
  - 等级：Suricata 优先级 1 → `high`，2 → `medium`，其余 → `low`；`critical` 留给跨域关联事件
  - `device_id`：目标 IP 在 `site.yaml` 中登记的设备，查不到为 null，告警照常发布（FR-203）
  - `event_id` 由 EVE 原文派生，重读同一行时不变，JetStream 据此去重；`evidence_ref` 为 `suricata:flow/<flow_id>`
- 发布（`service.py`）：JetStream 流 `HYD_SECURITY`，保留 365 天（architecture.md §10）。服务端确认后才记录位置，发布失败时下个周期重试
- 设备行为模型（`behavior.py`，`HYD_BEHAVIOR_ENABLED`，默认开启）：跟随 Zeek 的 `conn.log`，为每台已登记设备学习正常网络行为，偏离时发布 `behavior_anomaly` 告警（`source=model`，FR-205）到同一主题
  - 每 30 s 一个窗口，提取 7 项特征：会话数、访问方数、新访问方数、失败会话占比、入向字节、出向字节、平均会话时长
  - River HalfSpaceTrees 按窗口在线学习；先学 20 个窗口（10 分钟），只学习不告警
  - 分数 > 0.6、至少一项特征偏离基线 ≥ 3σ、连续 2 个窗口才告警。偏离窗口不参与学习，其中的访问方也不记为已见过
  - 状态每个窗口存盘（`HYD_BEHAVIOR_STATE_FILE`，持久卷），重启后续用；没有状态时可从 `HYD_BEHAVIOR_BASELINE_FILE` 的基线快照开始
- 关联（`engine.py`、`rules.py`）：订阅 `hyd.security.alert.v1`、`hyd.vision.integrity.v1`、`hyd.vision.behavior.v1`，按 `rules/correlator/<规则 ID>.yaml` 把同一设备窗口内先后出现的事件合并为关联事件，发布 `hyd.correlator.incident.v1`（JetStream 流 `HYD_INCIDENT`，保留 365 天）
  - 关联键为设备：告警取 `device_id`，视觉事件取 `camera_id`。时间一律取事件自带的 `ts`，按发生先后判断序列
  - `monitor` 告警、疑似级行为事件、目标未登记的告警不参与关联
  - 去重：同一规则、同一设备生成关联事件后 5 分钟内不再生成新事件，攻击持续时去重期顺延
  - 命中路径含模型来源的告警或画面事件、或含行为事件时，`requires_confirmation=true`，处置须人工确认（FR-407）
  - 同一事件同时补全单域与跨域规则时，命中路径被完整包含的单域事件不再发布，只留跨域事件
  - 关联事件的 `tactics` 按 `rules/attack/techniques.json` 由技术编号补全
  - 关联事件 ID 由规则 ID 与命中事件派生，重复发布由 JetStream 去重；发布失败时一直重试。重启时先重放近期关联事件恢复去重状态，再从“当前时刻 − 最长规则窗口”起重放事件
- 登记表热更新：订阅 `hyd.config.cameras.v1`，设备表随摄像头登记表原地更新（FR-203、FR-906）
- 演示开关（生产部署保持关闭）：`HYD_DEMO_RESET` 响应 `hyd.demo.reset.v1`，清空去重期以便重演攻击；`HYD_DEMO_QUIET` 按 `demo/scenarios/demo-quiet.yaml` 跳过易误报事件的关联
- 健康检查：主循环每个周期更新 `HYD_HEARTBEAT_FILE`，10 s 未更新视为卡死

## 配置项

见 `src/correlator/service.py` 的 `CorrelatorConfig`，环境变量前缀 `HYD_`。
