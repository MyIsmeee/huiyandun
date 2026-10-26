# audit-service

审计日志每日哈希链封存与校验（HYD-ARCH-001 §10.1、G-13）。审计记录由各服务与业务变更在同一事务内写入 `audit_log`（见 `services/api-server`），本服务只读审计日志、只追加封存记录。

## 职责

- 每个 UTC 自然日一条封存记录 `audit_seal`：`hash = SHA-256(前一日 hash ‖ 当日记录按 id 排序的规范化 JSON 行)`；无记录的日期同样封存，链条不留空档
- 零点后等待 10 分钟再封存前一日，覆盖跨零点提交的事务
- 校验：按当前审计日志重算全部封存记录，指出不一致的日期（修改、删除、补插记录均可检出）
- `audit_seal` 与 `audit_log` 一样只追加：应用账号无修改权限，触发器拒绝任何账号的修改

## 接口

无对外接口。命令行：

```sh
hyd-audit run      # 每 HYD_SEAL_INTERVAL_S 秒封存全部已结束的未封存日期；数据库不可达时下个周期补齐
hyd-audit verify   # 一致时以 0 退出；否则以 1 退出并列出日期
```

## 配置项

数据库连接配置与 api-server 共用（`api_server.config.DbConfig`），另有 `seal_interval_s`，见 `src/audit_service/cli.py`。

## 本地运行

```sh
uv run --all-packages pytest services/audit-service
```
