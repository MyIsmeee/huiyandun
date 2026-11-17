# privileged-helper

特权动作（architecture.md C-SEC-06，设计 `docs/archive/design/050-containment.md`，D-074）：只接受 playbook-executor 签名的指令，以固定模板操作宿主的 nftables。

## 职责

- 协议（`protocol.py`）：Unix 域套接字上一次连接一行 `{"payload", "signature"}`，Ed25519 签名覆盖 payload 原文；拒绝签名不符、时间偏差超过 30 s、随机数重复的指令；IP 须为合法单播地址，`ttl_s` 为 1～86400（C-BE-05）
- 动作只有三种（`nft.py`）：`block` 把源地址加入集合并设超时、`unblock` 删除（已到期视为成功）、`counters` 读该元素拦截的数据包数与剩余秒数。以参数列表调用 `nft`，不经 shell（SD-04）
- 启动时在一次事务内写入 `table inet hyd`：集合 `block4` / `block6`（`flags timeout; counter`）；forward 链对往来于其中地址的 TCP 报文回复 RST（切断已建立的会话）、其余协议丢弃，input 链对来自其中地址的报文同样处理。可重复执行：已有的封禁照常到期，规则先清空再写入，不会叠加
- TTL 由内核到期删除元素实现：helper 或 executor 重启都不影响到期解除

## 运行

Compose 中使用宿主网络、只有 `NET_ADMIN`、根文件系统只读，不接入任何容器网络（DP-05 例外，D-074）。套接字位于只与 playbook-executor 共享的卷 `helper-run`；公钥由 `make demo-up` 首次生成（`deploy/compose/.secrets/`，不入库，G-14）。

## 配置项

见 `src/privileged_helper/server.py` 的 `HelperConfig`，环境变量前缀 `HYD_`。

## 测试

单元测试以假的 nft 记录参数，不改宿主防火墙：

```sh
uv run pytest services/privileged-helper
```
