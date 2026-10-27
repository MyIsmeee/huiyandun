# api-server

对外 REST 与 WebSocket 接口，契约见 `contracts/openapi/api-server.v2.yaml`。

## 职责

- 统一错误格式（契约 `Error`）；写操作必须携带 `X-Request-ID`，请求 ID 绑定到日志并回写响应头（C-BE-08）
- 登录与 RBAC：本地账户，会话令牌只经 `HttpOnly` Cookie `hyd_session` 传递，数据库只存其 SHA-256；角色包含关系 viewer ⊂ operator ⊂ admin、viewer ⊂ auditor，审计日志只有 auditor 可读（C-BE-07、C-FE-06）
- WebSocket `/ws`：握手时校验会话 Cookie，向已登录客户端推送契约 `WsFrame`；会话到期、登出或客户端消费过慢时断开。数据源调用 `app.state.hub.broadcast()` 接入
- 审计日志：`api_server.audit.record` 与业务变更在同一事务内写入；表只追加（G-13）

## 数据库账号

| 账号 | 用途 | 权限 |
|---|---|---|
| `postgres`（属主） | 仅 `hyd-api migrate` | 建表、授权 |
| `hyd_app` | api-server 运行 | 按表授予；`audit_log` 只有 SELECT 与 INSERT，不能写 `id`、`ts`；`users` 只能新增；无权访问 `audit_seal` |
| `hyd_audit` | audit-service 运行 | 只读 `audit_log`；`audit_seal` 只有 SELECT 与 INSERT |

`hyd_app`、`hyd_audit` 由 `deploy/compose/postgres-init/` 在数据库首次初始化时创建。审计表另有触发器，拒绝任何账号的 UPDATE / DELETE / TRUNCATE；触发器只有属主能停用，因此服务不以属主账号连接。

## 配置项

见 `src/api_server/config.py`，环境变量前缀 `HYD_`。口令只从 `HYD_DB_PASSWORD_FILE` 指向的文件读取（G-14）。

## 本地运行

```sh
hyd-api migrate   # HYD_DB_USER=postgres，HYD_DB_PASSWORD_FILE 指向属主口令
hyd-api serve
hyd-api create-user <用户名> --role admin   # 交互输入口令，写审计（G-13、G-14）
```

M0 不做网页端账号管理；账户只能经命令行创建。

Compose 中由一次性服务 `migrate` 以属主账号执行迁移，`api-server` 只持有应用账号口令。`make demo-up` 后创建账户：

```sh
docker compose -f deploy/compose/compose.yaml --profile core exec api-server hyd-api create-user <用户名> --role admin
```

`GET /healthz` 供容器健康检查（数据库可达返回 204），不经 web-console 代理，不属于对外接口。

测试以 `compose.yaml` 锁定的 PostgreSQL 镜像启动临时容器：

```sh
uv run --all-packages pytest services/api-server
```
