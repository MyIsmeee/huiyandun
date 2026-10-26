#!/usr/bin/env bash
# 等待全部服务 healthy 并打印就绪耗时（HYD-DEP-005 §5.2）
# 用法：wait-healthy.sh <compose 命令...>；超时秒数取 HEALTH_TIMEOUT，默认 120
# 以 config --services 为应有清单：未创建、未定义健康检查或已退出的服务均按未就绪处理
# 例外：标签 hyd.oneshot=true 的一次性服务（如数据库迁移）以退出码 0 视为就绪
set -euo pipefail

timeout=${HEALTH_TIMEOUT:-120}
start=$SECONDS
expected=$("$@" config --services)
if [ -z "$expected" ]; then
  echo "未定义任何服务" >&2
  exit 1
fi

while :; do
  declare -A health=()
  # 以 | 分隔：Health 可能为空，Labels 含逗号分隔的 k=v
  while IFS='|' read -r service state status code labels; do
    [ -n "$service" ] || continue
    if [[ ",$labels," == *,hyd.oneshot=true,* && $status == exited ]]; then
      state="exited($code)"
      [ "$code" = 0 ] && state=healthy
    fi
    health[$service]=$state
  done <<<"$("$@" ps -a --format '{{.Service}}|{{.Health}}|{{.State}}|{{.ExitCode}}|{{.Labels}}')"

  pending=""
  for service in $expected; do
    state=${health[$service]-未创建}
    [ "$state" = healthy ] || pending+="$service $state"$'\n'
  done

  if [ -z "$pending" ]; then
    echo "全部服务 healthy，就绪耗时 $((SECONDS - start)) 秒"
    exit 0
  fi
  if ((SECONDS - start >= timeout)); then
    echo "等待 ${timeout} 秒后仍未就绪：" >&2
    printf '%s' "$pending" >&2
    exit 1
  fi
  sleep 2
done
