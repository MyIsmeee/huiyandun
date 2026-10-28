# 抓包镜像（C-SEC-08）：启动时执行一次 capture-tap.sh 后退出。复用已登记的基础镜像；
# iproute2（GPL-2.0）以独立进程运行（G-08）
FROM python:3.12.15-slim-bookworm@sha256:6a0e06f5ba0b373d051aabd3fffb9b873f27f9a2a3a14bcbe37dee6f0e3bbc70

RUN apt-get update \
    && apt-get install -y --no-install-recommends iproute2 \
    && rm -rf /var/lib/apt/lists/*
COPY --chmod=755 agents/sensor/capture-tap/capture-tap.sh /usr/local/bin/capture-tap

ENTRYPOINT ["capture-tap"]
