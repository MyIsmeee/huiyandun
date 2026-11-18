#!/usr/bin/env bash
# 测试二：自动化单元与集成测试（pytest 按模块逐个跑 + 前端 vitest），最后打印汇总表
# 用法：demo/tests/unit.sh                 全部模块
#       demo/tests/unit.sh api-server correlator web   只跑指定模块（名称见下方 MODULES）
# 不依赖运行中的演示栈；前端测试跑完会还原被 pnpm 改写的 pnpm-lock.yaml
set -uo pipefail
cd "$(dirname "$0")/../.."

if [ -t 1 ]; then G=$'\033[1;32m' R=$'\033[1;31m' Y=$'\033[33m' C=$'\033[1;36m' D=$'\033[2m' N=$'\033[0m'; else G= R= Y= C= D= N=; fi

declare -A MODULES=(
  [api-server]="services/api-server/tests|控制台后端接口"
  [correlator]="services/correlator/tests|关联引擎（单域、跨域规则）"
  [playbook-executor]="services/playbook-executor/tests|自动处置与回滚"
  [privileged-helper]="services/privileged-helper/tests|特权执行（封禁签名校验）"
  [evidence-service]="services/evidence-service/tests|证据哈希链存证"
  [evidence-verify]="libs/evidence-verify/tests|证据包离线校验"
  [audit-service]="services/audit-service/tests|审计日志"
  [llm-gateway]="services/llm-gateway/tests|AI 模型网关（脱敏）"
  [notifier]="services/notifier/tests|告警通知"
  [vision-engine]="services/vision-engine/tests|视觉识别（跌倒、打架、画面完整性）"
  [py-common]="libs/py-common/tests|公共库"
  [contracts]="tests|契约、编排与演示脚本"
  [dev-tools]="tools/dev/tests tools/codegen/tests tools/lint/tests|开发工具"
)
ORDER=(api-server correlator playbook-executor privileged-helper evidence-service evidence-verify audit-service
  llm-gateway notifier vision-engine py-common contracts dev-tools web)

selected=("$@")
[ ${#selected[@]} -eq 0 ] && selected=("${ORDER[@]}")

LOG_DIR=$(mktemp -d -t hyd-unit-XXXXXX)
results=()
total_pass=0 total_fail=0 any_fail=0
start=$SECONDS

for mod in "${selected[@]}"; do
  t0=$SECONDS
  if [ "$mod" = web ]; then
    desc="Web 控制台（vitest）"
    printf '\n%s▌%s  %s%s\n' "$C" "$mod" "$desc" "$N"
    log="$LOG_DIR/web.log"
    pnpm --dir web/console exec vitest run >"$log" 2>&1
    code=$?
    # 本机 pnpm 会把 @pnpm/exe 写进锁文件，影响镜像构建缓存
    git diff --quiet -- pnpm-lock.yaml || git checkout -- pnpm-lock.yaml
    line=$(sed 's/\x1b\[[0-9;]*m//g' "$log" | grep -E '^\s+Tests\s' | tail -1)
    p=$(grep -oE '[0-9]+ passed' <<<"$line" | grep -oE '[0-9]+' || echo 0)
    f=$(grep -oE '[0-9]+ failed' <<<"$line" | grep -oE '[0-9]+' || echo 0)
  else
    [ -n "${MODULES[$mod]+x}" ] || { echo "未知模块：$mod（可选：${ORDER[*]}）" >&2; exit 2; }
    IFS='|' read -r paths desc <<<"${MODULES[$mod]}"
    printf '\n%s▌%s  %s%s\n' "$C" "$mod" "$desc" "$N"
    log="$LOG_DIR/$mod.log"
    # shellcheck disable=SC2086
    uv run --all-packages pytest -q -p no:cacheprovider $paths >"$log" 2>&1
    code=$?
    line=$(grep -E '(passed|failed|error)' "$log" | tail -1)
    p=$(grep -oE '[0-9]+ passed' <<<"$line" | grep -oE '[0-9]+' || echo 0)
    f=$(( $(grep -oE '[0-9]+ failed' <<<"$line" | grep -oE '[0-9]+' || echo 0) + $(grep -oE '[0-9]+ errors?' <<<"$line" | grep -oE '[0-9]+' || echo 0) ))
  fi
  spent=$((SECONDS - t0))
  total_pass=$((total_pass + p)) total_fail=$((total_fail + f))
  if [ $code -eq 0 ]; then
    printf '  %s✓ 通过%s  %s 项，用时 %d 秒\n' "$G" "$N" "$p" "$spent"
    results+=("$mod|$desc|$p|$f|$spent|ok")
  else
    any_fail=1
    printf '  %s✗ 失败%s  通过 %s、失败 %s，用时 %d 秒  %s日志：%s%s\n' "$R" "$N" "$p" "$f" "$spent" "$D" "$log" "$N"
    sed 's/\x1b\[[0-9;]*m//g' "$log" | grep -E '^(FAILED|ERROR) ' | head -10 | sed "s/^/    $Y/;s/\$/$N/"
    results+=("$mod|$desc|$p|$f|$spent|fail")
  fi
done

printf '\n%s▌汇总%s\n' "$C" "$N"
printf '  %-20s %6s %6s %6s   %s\n' "module" "pass" "fail" "sec" "内容"
for r in "${results[@]}"; do
  IFS='|' read -r mod desc p f spent st <<<"$r"
  color=$G; [ "$st" = fail ] && color=$R
  printf '  %s%-20s%s %6s %6s %6s   %s\n' "$color" "$mod" "$N" "$p" "$f" "$spent" "$desc"
done
echo
if [ $any_fail -eq 0 ]; then
  printf '%s自动化测试：共 %d 项用例全部通过，用时 %d 秒%s\n' "$G" "$total_pass" $((SECONDS - start)) "$N"
else
  printf '%s自动化测试：通过 %d，失败 %d，用时 %d 秒；完整日志在 %s%s\n' "$R" "$total_pass" "$total_fail" $((SECONDS - start)) "$LOG_DIR" "$N"
  exit 1
fi
