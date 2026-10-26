# api-server

对外 REST 与 WebSocket 接口，契约见 `contracts/openapi/api-server.v2.yaml`。

## 职责

- 统一错误格式（契约 `Error`）；写操作必须携带 `X-Request-ID`，请求 ID 绑定到日志并回写响应头（C-BE-08）
- 登录与 RBAC：本地账户，会话令牌只经 `HttpOnly` Cookie `hyd_session` 传递，数据库只存其 SHA-256；角色包含关系 viewer ⊂ operator ⊂ admin、viewer ⊂ auditor（C-BE-07、C-FE-06）
- 审计日志：`api_server.audit.record` 与业务变更在同一事务内写入；表只追加（G-13）

## 数据库账号

| 账号 | 用途 | 权限 |
|---|---|---|
| `postgres`（属主） | 仅 `hyd-api migrate` | 建表、授权 |
| `hyd_app` | 服务运行 | 按表授予；`audit_log` 只有 SELECT 与 INSERT，不能写 `id`、`ts`；`users` 只能新增 |

`hyd_app` 由 `deploy/compose/postgres-init/` 在数据库首次初始化时创建。审计表另有触发器，拒绝任何账号的 UPDATE / DELETE / TRUNCATE；触发器只有属主能停用，因此服务不以属主账号连接。

## 配置项

见 `src/api_server/config.py`，环境变量前缀 `HYD_`。口令只从 `HYD_DB_PASSWORD_FILE` 指向的文件读取（G-14）。

## 本地运行

```sh
hyd-api migrate   # HYD_DB_USER=postgres，HYD_DB_PASSWORD_FILE 指向属主口令
hyd-api serve
```

测试以 `compose.yaml` 锁定的 PostgreSQL 镜像启动临时容器：

```sh
uv run --all-packages pytest services/api-server
```
