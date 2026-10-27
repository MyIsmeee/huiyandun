#!/bin/sh
# 数据库首次初始化时创建非属主账号（G-13）；表权限由 api-server 迁移授予
# hyd_app：api-server 使用；hyd_audit：audit-service 使用，唯一可写审计封存记录的账号
# 口令取自 secret 文件，不进入环境变量与日志（G-14）
set -eu
psql -v ON_ERROR_STOP=1 \
  -v app_pw="$(cat /run/secrets/db_app_password)" \
  -v audit_pw="$(cat /run/secrets/db_audit_password)" \
  --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
CREATE ROLE hyd_app LOGIN PASSWORD :'app_pw';
CREATE ROLE hyd_audit LOGIN PASSWORD :'audit_pw';
SQL
