"""审计日志每日哈希链封存记录（HYD-ARCH-001 §10.1），由 audit-service 写入，同样只追加。"""

from alembic import op

revision = "0003"
down_revision = "0002"


def upgrade() -> None:
    op.execute("""
        CREATE TABLE audit_seal (
            day date PRIMARY KEY,
            record_count integer NOT NULL,
            prev_hash bytea NOT NULL,
            hash bytea NOT NULL,
            sealed_at timestamptz NOT NULL DEFAULT clock_timestamp()
        )
    """)
    op.execute("""
        CREATE TRIGGER audit_seal_append_only
        BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_seal
        FOR EACH STATEMENT EXECUTE FUNCTION reject_modification()
    """)
    op.execute("GRANT SELECT ON audit_seal TO hyd_app")
    op.execute("GRANT INSERT (day, record_count, prev_hash, hash) ON audit_seal TO hyd_app")


def downgrade() -> None:
    op.execute("DROP TABLE audit_seal")
