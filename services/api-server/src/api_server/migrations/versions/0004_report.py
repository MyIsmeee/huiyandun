"""溯源报告（FR-501～FR-504、TK-070）。

hyd_app 只能查询、插入与写入复核两列，不能删除或改写报告内容；复核写审计日志（AI-M-05）。
"""

from alembic import op

revision = "0004"
down_revision = "0003"


def upgrade() -> None:
    op.execute("""
        CREATE TABLE report (
            id text PRIMARY KEY,
            incident_id text NOT NULL,
            facts jsonb NOT NULL,
            ai jsonb,
            source text NOT NULL CHECK (source IN ('llm', 'template')),
            provider_id text,
            degraded_reason text,
            reviewed_by text REFERENCES users,
            reviewed_at timestamptz,
            created_at timestamptz NOT NULL
        )
    """)
    op.execute("GRANT SELECT, INSERT ON report TO hyd_app")
    op.execute("GRANT UPDATE (reviewed_by, reviewed_at) ON report TO hyd_app")


def downgrade() -> None:
    op.execute("DROP TABLE report")
