"""供应商当日用量（D-084、TK-062）：调用次数与 Token，跨日（UTC）后从零累计。

保留策略（C-ST-02）：只存当日计数，随供应商删除而删除。
"""

from alembic import op

revision = "0006"
down_revision = "0005"


def upgrade() -> None:
    op.execute("""
        ALTER TABLE llm_providers
            ADD COLUMN usage_day date,
            ADD COLUMN usage_calls integer NOT NULL DEFAULT 0 CHECK (usage_calls >= 0),
            ADD COLUMN usage_tokens bigint NOT NULL DEFAULT 0 CHECK (usage_tokens >= 0)
    """)


def downgrade() -> None:
    op.execute("""
        ALTER TABLE llm_providers
            DROP COLUMN usage_day, DROP COLUMN usage_calls, DROP COLUMN usage_tokens
    """)
