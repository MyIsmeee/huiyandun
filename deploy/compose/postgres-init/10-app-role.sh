#!/bin/sh
# 数据库首次初始化时创建应用账号 hyd_app（非属主，G-13）；表权限由 api-server 迁移授予
# 口令取自 secret 文件，不进入环境变量与日志（G-14）
set -eu
psql -v ON_ERROR_STOP=1 -v pw="$(cat /run/secrets/db_app_password)" \
  --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
CREATE ROLE hyd_app LOGIN PASSWORD :'pw';
SQL
