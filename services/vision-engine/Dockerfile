# 构建上下文为仓库根目录（见 deploy/compose/compose.yaml）；基础镜像与 deploy/third-party.yaml 一致（C-RU-01）
# CUDA 13 cuDNN runtime：CUDA 主版本须与 onnxruntime-gpu 一致（C-HW-07、C-HW-08）；CPU 模式使用同一镜像（DP-06）
# 选 13.0：onnxruntime-gpu 1.31 按 13.0 构建；镜像要求驱动支持的 CUDA 不低于镜像版本，13.0 兼容全部 580 及以上驱动
FROM ghcr.io/astral-sh/uv:0.13.5@sha256:32a7bb39b496babbd997b0a39a4d66c126bdaf5661b302bf6f06abda8deca6ff AS uv

FROM nvidia/cuda:13.0.3-cudnn-runtime-ubuntu24.04@sha256:14f6d08d1cd4a96effbfe3101d0b56326f552c199d05e4979ee0bd616df5811b AS base
# 镜像不含 Python；使用 Ubuntu 24.04 的 3.12，版本锁定（G-15）
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3.12=3.12.3-1ubuntu0.17 \
    && rm -rf /var/lib/apt/lists/*

FROM base AS build
COPY --from=uv /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never UV_PYTHON=/usr/bin/python3.12
WORKDIR /app
COPY pyproject.toml uv.lock ./
COPY libs libs
COPY services services
# 按 uv.lock 安装（G-15）；--no-editable：运行镜像只需虚拟环境，不含源码目录
RUN uv sync --frozen --no-dev --no-editable --package vision-engine

FROM base
RUN useradd --system --uid 10001 --no-create-home hyd
COPY --from=build /app/.venv /app/.venv
# onnxruntime 默认在 import 时向 mobile.events.data.microsoft.com 发送遥测（抓包确认），须关闭（G-05）
ENV PATH=/app/.venv/bin:$PATH ORT_DISABLE_TELEMETRY=1
# C-OPS-04：非 root 运行
USER hyd
CMD ["hyd-gpu-check"]
