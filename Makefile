.PHONY: lint test codegen codegen-check doctor demo-up demo-down demo-health verify-models \
	test-rules llm-check demo-run

lint:
	uv run ruff check .
	uv run ruff format --check .

# --all-packages：测试会导入 libs/*、services/* 工作区包
test:
	uv run --all-packages pytest

codegen:
	uv run python tools/codegen/codegen.py

codegen-check:
	uv run python tools/codegen/codegen.py --check

COMPOSE = docker compose -f deploy/compose/compose.yaml \
	--profile core --profile vision --profile security --profile demo
PG_SECRET = deploy/compose/.secrets/postgres_password

doctor:
	tools/dev/doctor.sh

# 数据库口令首次启动时生成，只存于本机（G-14）
# 口令只在 pgdata 卷首次初始化时写入：删除此文件须同时删除卷（docker volume rm huiyandun_pgdata）
$(PG_SECRET):
	@mkdir -p $(@D)
	@umask 077 && head -c 32 /dev/urandom | base64 | tr -d '+/=' > $@

demo-up: $(PG_SECRET)
	$(COMPOSE) up -d

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
