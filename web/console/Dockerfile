# 构建上下文为仓库根目录（见 deploy/compose/compose.yaml）；基础镜像与 deploy/third-party.yaml 一致（C-RU-01）
FROM node:24.22.1-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c AS build
# pnpm 版本取自 package.json 的 packageManager；只在构建期联网
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY web/console/package.json web/console/
RUN pnpm install --frozen-lockfile --filter @huiyandun/console
COPY web/console web/console
RUN pnpm --dir web/console run build

FROM caddy:2.11.7-alpine@sha256:eb4d35b7452d1ab6171fbdbe8d9275b2301dad6dad92115d91e19fb9b24d510f
COPY --from=build /app/web/console/dist /srv
# C-OPS-04：非 root 运行；/data、/config 在基础镜像中对所有用户可写
USER 10001
