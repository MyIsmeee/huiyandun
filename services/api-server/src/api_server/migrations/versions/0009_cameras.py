"""摄像头登记表（FR-905、D-101、TK-125）。

口令只存 AES-256-GCM 密文（C-ST-03）；取流地址由 api-server 按 protocol、host、port、path 拼出（D-103）。
保留策略（C-ST-02）：配置数据，随管理员删除摄像头而删除。
"""

from alembic import op

revision = "0009"
down_revision = "0008"


def upgrade() -> None:
    op.execute("""
        CREATE TABLE cameras (
            id text PRIMARY KEY,
            name text NOT NULL,
            ip inet NOT NULL UNIQUE,
            ingest text NOT NULL CHECK (ingest IN ('pull', 'push')),
            protocol text CHECK (protocol IN ('rtsp', 'rtmp', 'http', 'onvif')),
            host text,
            port integer CHECK (port BETWEEN 1 AND 65535),
            path text,
            username text,
            password_enc bytea,
            pose jsonb NOT NULL,
            calibration jsonb NOT NULL,
            climb_lines jsonb NOT NULL,
            created_at timestamptz NOT NULL,
            updated_at timestamptz NOT NULL,
            CHECK ((ingest = 'pull') = (protocol IS NOT NULL AND host IS NOT NULL AND port IS NOT NULL))
        )
    """)
    op.execute("GRANT SELECT, INSERT, UPDATE, DELETE ON cameras TO hyd_app")


def downgrade() -> None:
    op.execute("DROP TABLE cameras")
