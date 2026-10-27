"""本地账户与会话（C-BE-07）。

账户只能新增（M0 不做网页端账号管理）；会话只存令牌的 SHA-256，登出与过期时删除。
"""

from alembic import op

revision = "0002"
down_revision = "0001"


def upgrade() -> None:
    op.execute("""
        CREATE TABLE users (
            username text PRIMARY KEY,
            password_hash text NOT NULL,
            role text NOT NULL CHECK (role IN ('viewer', 'operator', 'admin', 'auditor')),
            created_at timestamptz NOT NULL DEFAULT clock_timestamp()
        )
    """)
    op.execute("""
        CREATE TABLE sessions (
            token_hash bytea PRIMARY KEY,
            username text NOT NULL REFERENCES users,
            expires_at timestamptz NOT NULL
        )
    """)
    op.execute("GRANT SELECT, INSERT (username, password_hash, role) ON users TO hyd_app")
    op.execute("GRANT SELECT, INSERT, DELETE ON sessions TO hyd_app")


def downgrade() -> None:
    op.execute("DROP TABLE sessions")
    op.execute("DROP TABLE users")
