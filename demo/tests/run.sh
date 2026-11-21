#!/usr/bin/env bash
# 慧眼盾演示测试入口
# 用法：demo/tests/run.sh <项目>...
#   health   环境与服务健康检查（只读，约 2 秒）
#   unit     自动化单元/集成测试，按模块汇总（约 4～5 分钟；可跟模块名，见 unit.sh）
#   api      控制台接口冒烟测试（只读，约 15 秒，需账号）
#   guard    平台自身防护：控制台登录爆破检测（约 5 秒，需账号）
#   attack   攻防闭环端到端：爆破 → 封禁 → 画面重放 → 跨域事件 → 证据校验 → 回滚 → 复位（约 1 分钟，需账号）
#   quick    = health + api + guard
#   all      = health + unit + api + guard + attack
# 账号口令只输入一次：设置 HYD_USER、HYD_PASSWORD，未设置时开始前交互输入
set -uo pipefail
cd "$(dirname "$0")/../.."
HERE=demo/tests

if [ -t 1 ]; then B=$'\033[1m' G=$'\033[1;32m' R=$'\033[1;31m' N=$'\033[0m'; else B= G= R= N=; fi

usage() { sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
[ $# -eq 0 ] && usage

items=()
for a in "$@"; do
  case $a in
    quick) items+=(health api guard) ;;
    all) items+=(health unit api guard attack) ;;
    health | unit | api | guard | attack) items+=("$a") ;;
    -h | --help) usage ;;
    *) echo "未知项目：$a" >&2; usage ;;
  esac
done

needs_login=0
for i in "${items[@]}"; do [[ $i == api || $i == guard || $i == attack ]] && needs_login=1; done
if [ $needs_login = 1 ]; then
  [ -n "${HYD_USER:-}" ] || read -rp "控制台账号：" HYD_USER
  [ -n "${HYD_PASSWORD:-}" ] || { read -rsp "$HYD_USER 的口令：" HYD_PASSWORD; echo; }
  export HYD_USER HYD_PASSWORD
fi

PY=(uv run --all-packages python)
declare -A RESULT
start=$SECONDS
for i in "${items[@]}"; do
  printf '\n%s════════ %s ════════%s\n' "$B" "$i" "$N"
  case $i in
    health) "$HERE/health.sh" ;;
    unit) "$HERE/unit.sh" ;;
    api) "${PY[@]}" "$HERE/api_smoke.py" ;;
    guard) "${PY[@]}" "$HERE/login_guard.py" ;;
    attack) "${PY[@]}" "$HERE/attack_e2e.py" ;;
  esac
  RESULT[$i]=$?
done

if [ ${#items[@]} -gt 1 ]; then
  printf '\n%s════════ 总结（用时 %d 秒）════════%s\n' "$B" $((SECONDS - start)) "$N"
  failed=0
  for i in "${items[@]}"; do
    if [ "${RESULT[$i]}" = 0 ]; then printf '  %s✓%s %s\n' "$G" "$N" "$i"; else printf '  %s✗%s %s\n' "$R" "$N" "$i"; failed=1; fi
  done
  exit $failed
fi
exit "${RESULT[${items[0]}]}"
