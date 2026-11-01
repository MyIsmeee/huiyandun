"""AI 安全值班员调查记录（TK-116、FR-1102）。

hyd_app 可查询、插入与更新（调查进行中逐步写入），不能删除。保留 365 天（109 设计 §7），清理演示后实现。
"""

from alembic import op

revision = "0007"
down_revision = "0006"


def upgrade() -> None:
    op.execute("""
        CREATE TABLE ai_investigation (
            incident_id text PRIMARY KEY,
            steps jsonb NOT NULL,
            verdict jsonb,
            error text,
            provider jsonb,
            started_at timestamptz NOT NULL,
            finished_at timestamptz
        )
    """)
    op.execute("GRANT SELECT, INSERT, UPDATE ON ai_investigation TO hyd_app")


def downgrade() -> None:
    op.execute("DROP TABLE ai_investigation")
