"""摄像头兼容模式：经 MediaMTX（ingest）中继拉流（D-117、TK-144）。

只对拉流的 rtsp / rtmp 有效：部分设备在 SDP 中把媒体标为 sendonly，go2rtc 不接收，经 MediaMTX 中继即可。
"""

from alembic import op

revision = "0010"
down_revision = "0009"


def upgrade() -> None:
    op.execute("""
        ALTER TABLE cameras
            ADD COLUMN relay boolean NOT NULL DEFAULT false,
            ADD CONSTRAINT cameras_relay_check
                CHECK (NOT relay OR (ingest = 'pull' AND protocol IN ('rtsp', 'rtmp')))
    """)


def downgrade() -> None:
    op.execute("ALTER TABLE cameras DROP CONSTRAINT cameras_relay_check, DROP COLUMN relay")
