# 构建上下文为仓库根目录（见 deploy/compose/compose.yaml）；基础镜像与 deploy/third-party.yaml 一致（C-RU-01）
FROM ghcr.io/astral-sh/uv:0.13.5@sha256:32a7bb39b496babbd997b0a39a4d66c126bdaf5661b302bf6f06abda8deca6ff AS uv

FROM python:3.12.15-slim-bookworm@sha256:6a0e06f5ba0b373d051aabd3fffb9b873f27f9a2a3a14bcbe37dee6f0e3bbc70 AS build
COPY --from=uv /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never
WORKDIR /app
COPY pyproject.toml uv.lock ./
COPY libs libs
COPY services services
# 按 uv.lock 安装（G-15）；--no-editable：运行镜像只需虚拟环境，不含源码目录
RUN uv sync --frozen --no-dev --no-editable --package correlator

FROM python:3.12.15-slim-bookworm@sha256:6a0e06f5ba0b373d051aabd3fffb9b873f27f9a2a3a14bcbe37dee6f0e3bbc70
# EVE 读取位置所在目录：挂载为持久卷时，新建的卷沿用此目录的属主
RUN useradd --system --uid 10001 --no-create-home hyd \
    && install -d -o hyd /var/lib/correlator
COPY --from=build /app/.venv /app/.venv
ENV PATH=/app/.venv/bin:$PATH
# C-OPS-04：非 root 运行
USER hyd
CMD ["hyd-correlator"]
