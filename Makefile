.PHONY: lint lint-py lint-web test codegen codegen-check doctor demo-media demo-up demo-down demo-health \
	verify-models test-rules llm-check demo-run

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

COMPOSE = docker compose -f deploy/compose/compose.yaml \
	--profile core --profile vision --profile security --profile demo
SECRETS = deploy/compose/.secrets
DB_SECRETS = $(SECRETS)/postgres_password $(SECRETS)/db_app_password \
	$(SECRETS)/db_audit_password

doctor:
	tools/dev/doctor.sh

# 数据库口令首次启动时生成，只存于本机（G-14）
# 口令只在 pgdata 卷首次初始化时写入：删除这些文件须同时删除卷（docker volume rm huiyandun_pgdata）
$(DB_SECRETS):
	@mkdir -p -m 700 $(@D)
	@umask 077 && head -c 32 /dev/urandom | base64 | tr -d '+/=' > $@

# 目录只有本机属主可进入；文件须对容器内的非 root 进程可读（C-OPS-04）
# --build：自研服务镜像随代码更新；源码未变时全部命中缓存，无需联网
demo-up: $(DB_SECRETS)
	@chmod 700 $(SECRETS) && chmod 644 $(DB_SECRETS)
	$(COMPOSE) up -d --build

# 按 demo/media/*.meta.yaml 剪接演示视频（DM-12、FR-306）；原始片段放在 demo/media/src/
demo-media:
	uv run python tools/dev/build_media.py demo/media \
		"$$(docker compose -f deploy/compose/compose.yaml --profile demo config --images mediamtx)"

demo-down:
	$(COMPOSE) down

demo-health:
	tools/dev/wait-healthy.sh $(COMPOSE)

# 占位目标：对应任务实现前，执行即失败
todo = @echo "$@：由 $(1) 实现" >&2; exit 1

verify-models: ; $(call todo,TK-021)
test-rules: ; $(call todo,TK-030)
llm-check: ; $(call todo,TK-060)
demo-run: ; $(call todo,TK-100)
