.PHONY: lint lint-py lint-web test codegen codegen-check doctor demo-media demo-up demo-down demo-health \
	console-ca fetch-models verify-models test-rules llm-check demo-run

WEB = pnpm --dir web/console

lint: lint-py lint-web

lint-py:
	uv run ruff check .
	uv run ruff format --check .

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
COMPOSE = docker compose -f deploy/compose/compose.yaml \
	$(if $(filter 0,$(GPU)),,-f deploy/compose/compose.gpu.yaml) \
	--profile core --profile vision --profile security --profile demo
SECRETS = deploy/compose/.secrets
DB_SECRETS = $(SECRETS)/postgres_password $(SECRETS)/db_app_password \
	$(SECRETS)/db_audit_password
HELPER_KEY = $(SECRETS)/executor_signing_key

doctor:
	tools/dev/doctor.sh

# 数据库口令首次启动时生成，只存于本机（G-14）
# 口令只在 pgdata 卷首次初始化时写入：删除这些文件须同时删除卷（docker volume rm huiyandun_pgdata）
$(DB_SECRETS):
	@mkdir -p -m 700 $(@D)
	@umask 077 && head -c 32 /dev/urandom | base64 | tr -d '+/=' > $@

# playbook-executor 的签名私钥与 privileged-helper 的公钥（D-074），首次启动时生成，只存于本机（G-14）
$(HELPER_KEY):
	@mkdir -p -m 700 $(@D)
	@umask 077 && openssl genpkey -algorithm ed25519 -out $@ \
		&& openssl pkey -in $@ -pubout -out $(SECRETS)/helper_public_key

# 目录只有本机属主可进入；文件须对容器内的非 root 进程可读（C-OPS-04）
# --build：自研服务镜像随代码更新；源码未变时全部命中缓存，无需联网
demo-up: $(DB_SECRETS) $(HELPER_KEY)
	@chmod 700 $(SECRETS) && chmod 644 $(DB_SECRETS) $(HELPER_KEY) $(SECRETS)/helper_public_key
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

# 检测规则测试（CI-19、C-SEC-01）：构建 suricata 镜像，加载全部规则，回放 rules/tests/ 的样本并比对告警数
test-rules:
	docker build -q -t huiyandun/suricata:local -f agents/sensor/suricata/Dockerfile . > /dev/null
	uv run python tools/dev/check_rules.py huiyandun/suricata:local rules

# 占位目标：对应任务实现前，执行即失败
todo = @echo "$@：由 $(1) 实现" >&2; exit 1

llm-check: ; $(call todo,TK-060)
demo-run: ; $(call todo,TK-100)
