# 演示测试脚本

在仓库根目录运行，统一入口 `demo/tests/run.sh`。需要控制台账号的项目只问一次账号口令，
也可以事先设置环境变量（口令不落文件）：

```bash
export HYD_USER=<账号> HYD_PASSWORD=<口令>
```

| 命令 | 测什么 | 用时 | 会改动现场吗 |
|---|---|---|---|
| `demo/tests/run.sh health` | 宿主（Docker、显卡、磁盘）、全部容器健康状态、控制台与接口、模型文件与权重哈希、存证公钥指纹 | 约 2 秒 | 否 |
| `demo/tests/run.sh unit` | 按模块跑全部 pytest 与前端 vitest，最后出汇总表（`demo/tests/unit.sh correlator web` 只跑指定模块） | 约 4～5 分钟 | 否 |
| `demo/tests/run.sh api` | 接口冒烟：未登录拒绝、错误口令拒绝、登录与 Cookie 安全属性、各只读接口、WebSocket 实时推送、登出后失效 | 约 15 秒 | 否（记一次登录失败） |
| `demo/tests/run.sh guard` | 平台自身防护：5 次错误口令 → 控制台收到 HYD-WEB-0001 告警并标出来源；正常账号仍能登录 | 约 5 秒 | 产生 1 条告警 |
| `demo/tests/run.sh attack` | 攻防闭环：爆破 → 告警 → 关联事件 HYD-NET-0101 → 自动封禁 → 画面重放 → 跨域事件 HYD-X-0001 → 导出证据包并离线校验 → 篡改后校验报错 → 一键回滚 → 复位 | 约 1 分钟（刚篡改过画面时另加 1 分钟预热） | 产生告警；结束时自动 `make demo-reset` |
| `demo/tests/run.sh quick` | health + api + guard | 约 10 秒 | 同上 |
| `demo/tests/run.sh all` | 全部 | 约 6 分钟 | 同上 |

`attack` 的选项（直接运行 Python 脚本时）：

```bash
uv run --all-packages python demo/tests/attack_e2e.py --no-replay
```

只测爆破与封禁（约 30 秒）；加 `--keep` 则结束时不复位，留着现场给控制台展示。

## 演示建议

1. 开场先跑 `health`：一屏全绿，说明 20 多个服务全部就绪。
2. 跑 `unit correlator playbook-executor evidence-verify`：挑核心模块，几十秒出结果；完整的 `unit` 放到演示前跑好、只展示汇总表。
3. 跑 `api`、`guard`：讲鉴权与平台自身防护。
4. 浏览器开着控制台监控墙，再跑 `attack`：终端里逐步打勾，控制台同步出现告警、封禁与跨域事件。

## 注意

- `attack` 与 `guard` 会在控制台告警栏留下测试告警，正式演示前在控制台点 **清空告警**。
- `guard` 同一来源 60 秒只告警一次，连续重跑要间隔 1 分钟。
- `attack` 刚篡改过画面时会先预热 60 秒（重放须切回识别引擎看过的片段）。
- `attack` 导出的证据包存在 `demo/tests/out/`（已忽略，不入库）。
- 账号角色：`api` 任意角色；`attack` 需要 operator 或 admin（回滚、导出证据）。
- 截图对比类的 Playwright 用例因本机字体与基线不同必挂，所以这里不跑 e2e。
