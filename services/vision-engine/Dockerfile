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
# TensorRT 运行库（HYD_TENSORRT，见 runtime.TRT_*）：onnxruntime-gpu 的 TensorRT EP 动态加载 libnvinfer.so.10 与
# libnvonnxparser.so.10，缺失时只记警告、退回 CUDA。取基础镜像 CUDA 源里的 TensorRT 10 包，版本锁定（G-15）；
# 包名的 cuda13.2 为构建所用的 CUDA 小版本，CUDA 13 内向下兼容，13.0 运行库上实测可用。另带插件库（ONNX 解析器按需加载）。
# 约 2.5 GB，多为各代显卡的引擎构建资源。放在虚拟环境之前：源码改动不重新下载
ARG TENSORRT=10.16.1.11-1+cuda13.2
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        libnvinfer10=${TENSORRT} libnvonnxparsers10=${TENSORRT} libnvinfer-plugin10=${TENSORRT} \
    && rm -rf /var/lib/apt/lists/*
RUN useradd --system --uid 10001 --no-create-home hyd \
    # TensorRT 引擎缓存（HYD_TRT_CACHE_DIR）：compose 挂命名卷，首次挂载时按此处的属主初始化
    && mkdir -p /var/cache/hyd-trt && chown hyd /var/cache/hyd-trt
COPY --from=build /app/.venv /app/.venv
# onnxruntime 默认在 import 时向 mobile.events.data.microsoft.com 发送遥测（抓包确认），须关闭（G-05）。
# OpenBLAS（numpy 与 OpenCV 各带一份）单线程：引擎里只有卡尔曼滤波、单应矩阵这类小矩阵运算，默认各开 23 个线程、
# 每次运算后忙等，5 路并发时这 46 个线程各占约半个核却不做事（2026-11-18 实测）
ENV PATH=/app/.venv/bin:$PATH ORT_DISABLE_TELEMETRY=1 OPENBLAS_NUM_THREADS=1
# C-OPS-04：非 root 运行
USER hyd
CMD ["hyd-vision"]
