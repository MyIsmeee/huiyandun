.PHONY: lint test codegen codegen-check doctor demo-up demo-down demo-health verify-models \
	test-rules llm-check demo-run

lint:
	uv run ruff check .
	uv run ruff format --check .

test:
	uv run pytest

# 占位目标：对应任务实现前，执行即失败
todo = @echo "$@：由 $(1) 实现" >&2; exit 1

codegen codegen-check: ; $(call todo,TK-003)
doctor demo-up demo-down demo-health: ; $(call todo,TK-004)
verify-models: ; $(call todo,TK-021)
test-rules: ; $(call todo,TK-030)
llm-check: ; $(call todo,TK-060)
demo-run: ; $(call todo,TK-100)
