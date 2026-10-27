"""审计日志：只追加（G-13、HYD-ARCH-001 §10.1）。

两道防线：应用账号 hyd_app 只有 SELECT 与 INSERT 权限，且不能写入 id、ts；触发器拒绝任何账号的
UPDATE / DELETE / TRUNCATE。触发器只有属主能停用，因此应用不以属主账号连接。
hyd_app 由 deploy/compose/postgres-init 在数据库初始化时创建。
"""

from alembic import op

revision = "0001"
down_revision = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE audit_log (
            id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            ts timestamptz NOT NULL DEFAULT clock_timestamp(),
            actor text NOT NULL,
            action text NOT NULL,
            target text NOT NULL,
            before jsonb,
            after jsonb,
            request_id text NOT NULL
        )
    """)
    op.execute("""
        CREATE FUNCTION reject_modification() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
            RAISE EXCEPTION '% 只允许追加', TG_TABLE_NAME;
        END
        $$
    """)
    # 语句级触发：未命中任何行的 UPDATE / DELETE 同样被拒绝
    op.execute("""
        CREATE TRIGGER audit_log_append_only
        BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_log
        FOR EACH STATEMENT EXECUTE FUNCTION reject_modification()
    """)
    op.execute("GRANT SELECT ON audit_log TO hyd_app")
    op.execute(
        "GRANT INSERT (actor, action, target, before, after, request_id) ON audit_log TO hyd_app"
    )


def downgrade() -> None:
    op.execute("DROP TABLE audit_log")
    op.execute("DROP FUNCTION reject_modification()")
