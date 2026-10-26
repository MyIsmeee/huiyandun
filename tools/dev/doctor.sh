#!/usr/bin/env bash
# 环境自检（HYD-DEP-005 §2）：任一失败即终止并打印修复提示
# vision-engine hyd-gpu-check（C-CV-11）随 vision-engine 由 TK-021 加入
set -uo pipefail

# 须与 deploy/third-party.yaml 登记一致
CUDA_IMAGE=nvidia/cuda:12.8.0-base-ubuntu24.04@sha256:e778509d37d66475120929671500377524f7278478ba08131b07ef3ffcc0dce0

check() {
  local hint=$1
  shift
  echo "检查：$*"
  if ! "$@" >/dev/null 2>&1; then
    echo "失败：$*" >&2
    echo "修复：$hint" >&2
    exit 1
  fi
}

check "在 Windows 侧安装或更新 NVIDIA 驱动；WSL 内不要安装显卡驱动（C-HW-10）" \
  nvidia-smi
check "在 WSL 内启动 Docker Engine（sudo service docker start），并确认当前用户可访问 Docker" \
  docker info
check "安装 NVIDIA Container Toolkit，执行 sudo nvidia-ctk runtime configure --runtime=docker 后重启 Docker；断网环境须预先拉取 $CUDA_IMAGE" \
  docker run --rm --gpus all "$CUDA_IMAGE" nvidia-smi

echo "环境自检通过"
