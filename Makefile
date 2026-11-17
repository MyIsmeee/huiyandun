.PHONY: licenses lint lint-py lint-imports lint-web test codegen codegen-check doctor demo-media demo-up demo-down demo-health \
	console-ca fetch-models verify-models test-rules eval-behavior explain-fall explain-live llm-check attack attack-slow attack-hijack tamper demo-reset

WEB = pnpm --dir web/console

lint: lint-py lint-imports lint-web

lint-py:
	uv run ruff check .
	uv run ruff format --check .

# CI-06 模块依赖边界（G-03）：只分析源码，经 PYTHONPATH 找到各服务包，不安装服务的运行时依赖
lint-imports:
	PYTHONPATH=$$(ls -d services/*/src libs/*/src | paste -sd:) uv run lint-imports

lint-web:
	$(WEB) exec eslint .
	$(WEB) exec tsc --noEmit

# --all-packages：测试会导入 libs/*、services/* 工作区包
test:
	uv run --all-packages pytest
	$(WEB) exec vitest run

# web/console/src/api 由 openapi-typescript 生成，命令见 web/console/package.json
codegen:
	uv run python tools/codegen/codegen.py
	$(WEB) run codegen

codegen-check:
	uv run python tools/codegen/codegen.py --check
	$(WEB) run codegen:check

# 默认加载 GPU 覆盖文件；无 GPU 时须显式 GPU=0，vision-engine 以 CPU 模式运行，不依赖回退（DP-06、C-CV-11）
GPU ?= 1
# LINKAGE=1：旁路部署演示（FR-1001），边缘主机只听不发，封禁经外部防火墙联动网关执行（compose.linkage.yaml）
LINKAGE ?= 0
# NOTIFY=1：告警推送到企业微信、钉钉群机器人（compose.notify.yaml）；机器人地址写在 .secrets/notify_targets
NOTIFY ?= 0
COMPOSE = docker compose -f deploy/compose/compose.yaml \
	$(if $(filter 0,$(GPU)),,-f deploy/compose/compose.gpu.yaml) \
	$(if $(filter 1,$(LINKAGE)),-f deploy/compose/compose.linkage.yaml --profile linkage) \
	$(if $(filter 1,$(NOTIFY)),-f deploy/compose/compose.notify.yaml --profile notify) \
	--profile core --profile vision --profile security --profile demo
SECRETS = deploy/compose/.secrets
DB_SECRETS = $(SECRETS)/postgres_password $(SECRETS)/db_app_password \
	$(SECRETS)/db_audit_password
HELPER_KEY = $(SECRETS)/executor_signing_key
LLM_KEY = $(SECRETS)/llm_key_secret
DEVICE_KEY = $(SECRETS)/device_key_secret
PUSH_PASS = $(SECRETS)/push_password
EVIDENCE_KEY = $(SECRETS)/evidence_signing_key
GATEWAY_CERT = $(SECRETS)/firewall_gateway_cert

doctor:
	tools/dev/doctor.sh

# 数据库口令与推流口令（D-103）首次启动时生成，只存于本机（G-14）
# 口令只在 pgdata 卷首次初始化时写入：删除这些文件须同时删除卷（docker volume rm huiyandun_pgdata）
$(DB_SECRETS) $(PUSH_PASS):
	@mkdir -p -m 700 $(@D)
	@umask 077 && head -c 32 /dev/urandom | base64 | tr -d '+/=' > $@

# playbook-executor 的签名私钥与 privileged-helper 的公钥（D-074），首次启动时生成，只存于本机（G-14）
$(HELPER_KEY):
	@mkdir -p -m 700 $(@D)
	@umask 077 && openssl genpkey -algorithm ed25519 -out $@ \
		&& openssl pkey -in $@ -pubout -out $(SECRETS)/helper_public_key

# 加密供应商 API Key、摄像头口令的 32 字节密钥（C-ST-03、D-101），首次启动时生成，只存于本机（G-14）
# 删除或更换后，已存的 Key 与口令无法解密，须在供应商页、摄像头页重新填写
$(LLM_KEY) $(DEVICE_KEY):
	@mkdir -p -m 700 $(@D)
	@umask 077 && head -c 32 /dev/urandom | base64 > $@

# evidence-service 的存证签名私钥（D-098），首次启动时生成，只存于本机（G-14）
# 删除或更换后，已有记录验签失败，evidence-service 拒绝启动（M0 不支持换钥）
$(EVIDENCE_KEY):
	@mkdir -p -m 700 $(@D)
	@umask 077 && openssl genpkey -algorithm ed25519 -out $@

# 外部防火墙联动网关的自签 TLS 证书（旁路部署演示，FR-1001），首次以 LINKAGE=1 启动时生成，只存于本机（G-14）
# 证书即执行器信任的 CA，只对 linkage-net 的宿主地址有效；真实部署换成客户网关的证书与签发它的 CA
$(GATEWAY_CERT):
	@mkdir -p -m 700 $(@D)
	@umask 077 && openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 3650 \
		-subj /CN=hyd-firewall-gateway -addext subjectAltName=IP:172.30.13.1 \
		-addext basicConstraints=critical,CA:TRUE -keyout $(SECRETS)/firewall_gateway_key -out $@ 2> /dev/null

LINKAGE_SECRETS = $(if $(filter 1,$(LINKAGE)),$(GATEWAY_CERT))

# 告警通知的机器人列表：首次以 NOTIFY=1 启动时建一个空列表（不推送），按 services/notifier/README.md 填写
NOTIFY_TARGETS = $(SECRETS)/notify_targets
$(NOTIFY_TARGETS):
	@mkdir -p -m 700 $(@D)
	@umask 077 && echo "[]" > $@
NOTIFY_SECRETS = $(if $(filter 1,$(NOTIFY)),$(NOTIFY_TARGETS))

# 目录只有本机属主可进入；文件须对容器内的非 root 进程可读（C-OPS-04）
# --build：自研服务镜像随代码更新；源码未变时全部命中缓存，无需联网
demo-up: $(DB_SECRETS) $(HELPER_KEY) $(LLM_KEY) $(DEVICE_KEY) $(PUSH_PASS) $(EVIDENCE_KEY) $(LINKAGE_SECRETS) $(NOTIFY_SECRETS)
	@chmod 700 $(SECRETS) && chmod 644 $(DB_SECRETS) $(HELPER_KEY) $(SECRETS)/helper_public_key $(LLM_KEY) \
		$(DEVICE_KEY) $(PUSH_PASS) $(EVIDENCE_KEY) \
		$(if $(LINKAGE_SECRETS),$(GATEWAY_CERT) $(SECRETS)/firewall_gateway_key) \
		$(NOTIFY_SECRETS)
	$(COMPOSE) up -d --build

# 按 demo/media/*.meta.yaml 剪接演示视频（DM-12、FR-306）；原始片段放在 demo/media/src/
demo-media:
	uv run python tools/dev/build_media.py demo/media \
		"$$(docker compose -f deploy/compose/compose.yaml --profile demo config --images mediamtx)"

demo-down:
	$(COMPOSE) down

demo-health:
	tools/dev/wait-healthy.sh $(COMPOSE)

# web-console 本地 CA 的根证书（公开内容），导入演示机浏览器信任库后访问 https://127.0.0.1 无警告
console-ca:
	$(COMPOSE) exec -T web-console cat /data/caddy/pki/authorities/local/root.crt > hyd-local-ca.crt
	@echo "已导出 hyd-local-ca.crt"

# CV 模型权重不入库（R-03）：按 models/registry.yaml 下载并校验哈希（C-RU-06）
fetch-models:
	uv run python tools/dev/models.py fetch models

verify-models:
	uv run python tools/dev/models.py verify models

# 第三方许可证声明（G-08、C-RU-02）：依赖变化后重新生成并提交。
# 先写临时文件，生成失败时不清空已提交的清单
licenses:
	uv run python tools/dev/third_party_licenses.py > LICENSE-THIRD-PARTY.md.tmp \
		&& mv LICENSE-THIRD-PARTY.md.tmp LICENSE-THIRD-PARTY.md \
		|| { rm -f LICENSE-THIRD-PARTY.md.tmp; exit 1; }

# 检测规则测试（CI-19、C-SEC-01）：构建 suricata 镜像，加载全部规则，回放 rules/tests/ 的样本并比对告警数
test-rules:
	docker build -q -t huiyandun/suricata:local -f agents/sensor/suricata/Dockerfile . > /dev/null
	uv run python tools/dev/check_rules.py huiyandun/suricata:local rules

# 行为判定事件级评测（TK-160）：回放 services/vision-engine/tests/clips 的骨骼轨迹，按同名标注统计召回、误报与延迟
# 已下载骨骼动作模型时按"规则 + 模型"联合判定评测，与线上一致；NO_ACTION=1 时只评规则
ACTION_MODEL = models/weights/stgcnpp_ntu60_2d_jb.onnx
eval-behavior:
	uv run --all-packages python tools/dev/eval_behavior.py \
		$(if $(filter 1,$(NO_ACTION)),,$(if $(wildcard $(ACTION_MODEL)),--action $(ACTION_MODEL)))

# 跌倒判定逐帧诊断（现场调试）：CLIP 为录制的 .npz 或视频文件，逐段说明每条轨迹卡在哪项条件并给出建议
# 例：make explain-fall CLIP=现场测试.mp4；只看某条轨迹或逐帧明细时直接运行 tools/dev/explain_behavior.py --help
explain-fall:
	uv run --all-packages python tools/dev/explain_behavior.py "$(CLIP)"

# 跌倒判定实时诊断：在运行中的视觉引擎容器内从 go2rtc 录 CAMERA 的 DURATION 秒骨骼轨迹（CPU，不占线上显卡，
# 不需要摄像头口令），存为 live-<摄像头>.npz（只含关键点数字，不含画面）后诊断。例：make explain-live CAMERA=cam-06
DURATION ?= 60
LIVE = /tmp/hyd-explain
explain-live:
	$(COMPOSE) exec -T vision-engine mkdir -p $(LIVE)
	$(COMPOSE) cp services/vision-engine/src/vision_engine vision-engine:$(LIVE)/
	$(COMPOSE) cp tools/dev/explain_behavior.py vision-engine:$(LIVE)/
	$(COMPOSE) cp tools/dev/record_keypoints.py vision-engine:$(LIVE)/
	$(COMPOSE) exec -T -w $(LIVE) -e PYTHONPATH=$(LIVE) -e HYD_DEVICE=cpu vision-engine python explain_behavior.py \
		rtsp://go2rtc:8554/$(CAMERA) --seconds $(DURATION) --save $(LIVE)/live.npz 2>&1 | grep -v "WARN\|onnxruntime"; \
		$(COMPOSE) cp vision-engine:$(LIVE)/live.npz live-$(CAMERA).npz; \
		$(COMPOSE) exec -T -u root vision-engine rm -rf $(LIVE)

# 占位目标：对应任务实现前，执行即失败
todo = @echo "$@：由 $(1) 实现" >&2; exit 1

llm-check: ; $(call todo,TK-060)

# 红方手动命令（D-105、ops.md §4.1）：演示与走查时由队员执行，不发布任何事件。
# M0 只能攻击自建靶机 rtsp-target，它的地址即 cam-02 的设备 IP；攻击现场摄像头待 D-064 实现
TARGET ?= cam-02
CAMERA ?= cam-02
# attack 认证爆破；attack-slow 低速爆破；attack-hijack 推流劫持（ANNOUNCE）。三者各自即触发封禁（HYD-NET-0101、
# HYD-NET-0103 行为模型判定须人工确认、HYD-NET-0102），不必再接 make tamper
attack attack-slow attack-hijack:
	$(if $(filter-out cam-02,$(TARGET)),$(error M0 只能攻击自建靶机 rtsp-target（cam-02）))
	uv run python tools/dev/redteam.py $@ -- $(COMPOSE)

# ACTION：freeze 定格、replay 切回约 2 分钟前、restore 恢复；只作用于调试素材（mediamtx 推流）
tamper:
	uv run python tools/dev/redteam.py tamper $(ACTION) $(CAMERA) -- $(COMPOSE)

# 演示复位：回滚仍在生效的封禁、清空关联引擎的 5 分钟去重期，并恢复被篡改的调试画面，之后可立即重演。
# 重放要被识别，恢复后的画面须先正常播放约 2.5 分钟，再执行 make tamper ACTION=replay
demo-reset:
	$(COMPOSE) exec -T api-server hyd-api demo-reset
	@for f in /tmp/hyd-tamper-*.json; do \
		grep -qs '"tampered": true' "$$f" || continue; \
		cam=$$(basename "$$f" .json); \
		uv run python tools/dev/redteam.py tamper restore "$${cam#hyd-tamper-}" -- $(COMPOSE) || exit 1; \
	done
