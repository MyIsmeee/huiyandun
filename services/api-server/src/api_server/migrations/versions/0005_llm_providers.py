"""模型供应商与全局设置（FR-601～FR-605、TK-060）。

API Key 只存 AES-256-GCM 密文与末 4 位（C-ST-03、C-LLM-15）；position 即故障转移顺序（FR-603）。
保留策略（C-ST-02）：配置数据，随管理员删除供应商而删除。
"""

from alembic import op

revision = "0005"
down_revision = "0004"


def upgrade() -> None:
    op.execute("""
        CREATE TABLE llm_providers (
            id text PRIMARY KEY,
            name text NOT NULL,
            preset text NOT NULL,
            base_url text NOT NULL,
            api_key_enc bytea,
            api_key_last4 text,
            model text NOT NULL,
            network text NOT NULL CHECK (network IN ('internal', 'public')),
            network_overridden boolean NOT NULL,
            structured_output text CHECK (structured_output IN ('json_schema', 'json_object', 'none')),
            timeout_s integer NOT NULL CHECK (timeout_s >= 1),
            enabled boolean NOT NULL,
            position integer NOT NULL,
            last_test jsonb,
            created_at timestamptz NOT NULL,
            updated_at timestamptz NOT NULL
        )
    """)
    op.execute("""
        CREATE TABLE llm_settings (
            id boolean PRIMARY KEY DEFAULT true CHECK (id),
            block_public boolean NOT NULL
        )
    """)
    op.execute("INSERT INTO llm_settings (block_public) VALUES (false)")
    op.execute("GRANT SELECT, INSERT, UPDATE, DELETE ON llm_providers TO hyd_app")
    op.execute("GRANT SELECT, UPDATE ON llm_settings TO hyd_app")


def downgrade() -> None:
    op.execute("DROP TABLE llm_settings")
    op.execute("DROP TABLE llm_providers")
