# notifier：告警推送到企业微信、钉钉

可选服务。确认级物理告警（跌倒、攀爬、长时间静止、打架、区域入侵、越线）与等级为严重、高的关联事件，推送到企业微信群机器人、钉钉群机器人或通用 Webhook。

## 启用

1. 首次启动会生成空的机器人列表 `deploy/compose/.secrets/notify_targets`：

   ```bash
   make demo-up NOTIFY=1
   ```

2. 编辑这个文件（YAML 列表），填入机器人地址：

   ```yaml
   - kind: wecom      # 企业微信群机器人
     url: https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=你的key
   - kind: dingtalk   # 钉钉群机器人；安全设置选"加签"时填 secret
     url: https://oapi.dingtalk.com/robot/send?access_token=你的token
     secret: SEC开头的加签密钥
   - kind: webhook    # 通用 Webhook：POST JSON，含标题、正文与原始事件
     url: https://你的系统/hook
   ```

3. 想在通知里附上控制台链接，设置环境变量 `HYD_CONSOLE_URL`（例如 `https://192.168.1.10`），然后重新执行一次 `make demo-up NOTIFY=1`。

## 规则

- 疑似告警、区域内持续停留（update）和离开（end）不推送，中、低等级的关联事件也不推送。
- 同一摄像头、同一类告警 60 秒内只推一次（`HYD_COOLDOWN_S`）。每个机器人每分钟最多推 18 条，避开平台约 20 条/分钟的限流，超出部分丢弃并记日志。
- 平台拒收（errcode 不为 0）或网络失败只记日志、不重试。控制台的告警栏和弹窗不受影响。
- 重启后不补推历史告警。

## 安全

这是除 llm-gateway 之外唯一能出外网的服务。它只订阅告警事件，不接入数据库、视频和处置网络，也不开放端口。不叠加 `compose.notify.yaml` 时，系统的出网面与默认部署相同。
