# 受控攻击模拟（DP-09、C-SEC-11）：只对 rtsp-target 发 RTSP 认证重试，触发 HYD-NET-0001。
# 镜像内不含任何通用扫描/利用工具，只有标准库脚本，不安装任何依赖（基础镜像已登记于 deploy/third-party.yaml）
FROM python:3.12.15-slim-bookworm@sha256:6a0e06f5ba0b373d051aabd3fffb9b873f27f9a2a3a14bcbe37dee6f0e3bbc70

COPY --chmod=755 agents/sim/attack-sim/rtsp_bruteforce.py /usr/local/bin/rtsp-bruteforce
USER nobody
ENTRYPOINT ["rtsp-bruteforce"]
