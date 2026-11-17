# 主机轻量探针：只有标准库脚本，不安装任何依赖（基础镜像已登记于 deploy/third-party.yaml）
FROM python:3.12.15-slim-bookworm@sha256:6a0e06f5ba0b373d051aabd3fffb9b873f27f9a2a3a14bcbe37dee6f0e3bbc70

COPY --chmod=755 agents/sensor/host-probe/host_probe.py /usr/local/bin/host-probe
ENTRYPOINT ["host-probe"]
