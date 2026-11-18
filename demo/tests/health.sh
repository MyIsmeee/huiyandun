#!/usr/bin/env bash
# 测试一：环境与服务健康检查（只读，不改动任何状态）
# 用法：demo/tests/health.sh        GPU=0 时跳过显卡检查
set -uo pipefail
cd "$(dirname "$0")/../.."

URL=${HYD_URL:-https://127.0.0.1}
PROJECT=huiyandun
pass=0 fail=0
fails=()

if [ -t 1 ]; then G=$'\033[1;32m' R=$'\033[1;31m' C=$'\033[1;36m' D=$'\033[2m' N=$'\033[0m'; else G= R= C= D= N=; fi

ok()   { printf '  %s✓ 通过%s  %s %s%s%s\n' "$G" "$N" "$1" "$D" "${2:-}" "$N"; pass=$((pass + 1)); }
bad()  { printf '  %s✗ 失败%s  %s %s%s%s\n' "$R" "$N" "$1" "$D" "${2:-}" "$N"; fail=$((fail + 1)); fails+=("$1 ${2:-}"); }
step() { printf '\n%s▌%s%s\n' "$C" "$1" "$N"; }

start=$SECONDS

step "1. 宿主环境"
if docker info >/dev/null 2>&1; then ok "Docker 引擎可用" "$(docker version --format '{{.Server.Version}}' 2>/dev/null)"; else bad "Docker 引擎不可用"; fi
if [ "${GPU:-1}" != 0 ]; then
  if gpu=$(nvidia-smi --query-gpu=name,memory.used,memory.total --format=csv,noheader 2>/dev/null); then
    ok "NVIDIA 显卡" "$gpu"
  elif nvidia-smi >/dev/null 2>&1; then
    ok "NVIDIA 显卡" "$(nvidia-smi -L | head -1)"
  else
    bad "NVIDIA 显卡不可用" "（无显卡时用 GPU=0 运行）"
  fi
fi
free_gb=$(df -BG --output=avail . | tail -1 | tr -dc 0-9)
if [ "${free_gb:-0}" -ge 10 ]; then ok "磁盘剩余空间" "${free_gb} GB"; else bad "磁盘剩余空间不足 10 GB" "${free_gb} GB"; fi

step "2. 容器状态（compose 项目 $PROJECT）"
mapfile -t rows < <(docker ps -a --filter "label=com.docker.compose.project=$PROJECT" \
  --format '{{.Label "com.docker.compose.service"}}|{{.State}}|{{.Status}}|{{.Label "hyd.oneshot"}}' | sort)
if [ ${#rows[@]} -eq 0 ]; then
  bad "没有找到演示栈的容器" "先执行 make demo-up"
fi
for row in "${rows[@]}"; do
  IFS='|' read -r svc state status oneshot <<<"$row"
  if [ "$oneshot" = true ]; then
    [[ $status == *"Exited (0)"* ]] && ok "$svc" "一次性任务已成功完成" || bad "$svc" "$status"
  elif [[ $status == *"(healthy)"* ]]; then
    ok "$svc" "$status"
  elif [ "$state" = running ] && [[ $status != *health* ]]; then
    ok "$svc" "$status（无健康检查）"
  else
    bad "$svc" "$status"
  fi
done

step "3. 控制台与接口"
t=$(curl -sk -o /dev/null -w '%{http_code} %{time_total}' "$URL/")
read -r code secs <<<"$t"
[ "$code" = 200 ] && ok "控制台首页 $URL" "HTTP $code，${secs}s" || bad "控制台首页 $URL" "HTTP $code"
# /healthz 不经 Caddy 对外，在容器内访问
code=$(docker exec ${PROJECT}-api-server-1 python -c \
  "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=5).status)" 2>/dev/null)
[ "$code" = 204 ] && ok "api-server 健康检查 /healthz" "HTTP $code" || bad "api-server 健康检查 /healthz" "HTTP ${code:-无响应}"
code=$(curl -sk -o /dev/null -w '%{http_code}' "$URL/api/site")
[ "$code" = 401 ] && ok "未登录访问接口被拒绝" "/api/site → HTTP $code" || bad "未登录访问接口应返回 401" "/api/site → HTTP $code"
cert=$(echo | openssl s_client -connect "${URL#https://}:443" -servername localhost 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null)
[ -n "$cert" ] && ok "HTTPS 证书" "${cert#notAfter=} 到期" || bad "HTTPS 证书读取失败"

step "4. 视觉引擎与模型"
if docker exec ${PROJECT}-vision-engine-1 true 2>/dev/null; then
  gpu_line=$(docker logs --since 24h ${PROJECT}-vision-engine-1 2>&1 | grep -m1 -oE '"providers?": ?\[[^]]*\]' || true)
  ok "vision-engine 运行中" "${gpu_line:-}"
  n=$(docker exec ${PROJECT}-vision-engine-1 sh -c 'ls /models/*.onnx 2>/dev/null | wc -l')
  [ "${n:-0}" -gt 0 ] && ok "容器内模型文件" "$n 个 ONNX 模型" || bad "容器内没有模型文件" "先执行 make fetch-models"
else
  bad "vision-engine 未运行"
fi
if out=$(uv run python tools/dev/models.py verify models 2>&1); then
  ok "模型权重哈希校验（make verify-models）" "$(echo "$out" | tail -1)"
else
  bad "模型权重哈希校验" "$(echo "$out" | tail -1)"
fi

step "5. 存证服务"
fp=$(docker logs ${PROJECT}-evidence-service-1 2>&1 | grep evidence.started | tail -1 | grep -oE 'sha256:[0-9a-f]{64}')
[ -n "$fp" ] && ok "存证签名公钥指纹" "$fp" || bad "取不到存证公钥指纹"

echo
total=$((pass + fail))
if [ $fail -eq 0 ]; then
  printf '%s健康检查：共 %d 项，全部通过，用时 %d 秒%s\n' "$G" "$total" $((SECONDS - start)) "$N"
else
  printf '%s健康检查：共 %d 项，通过 %d，失败 %d%s\n' "$R" "$total" "$pass" "$fail" "$N"
  for f in "${fails[@]}"; do printf '  %s✗ %s%s\n' "$R" "$f" "$N"; done
  exit 1
fi
