"""USB 摄像头：插在边缘主机上，由 ingest 读取设备（api_server/usb.py）。设备标识（/dev/v4l/by-id 下的名字）存于 path。"""

from alembic import op

revision = "0014"
down_revision = "0013"


def upgrade() -> None:
    op.execute("ALTER TABLE cameras DROP CONSTRAINT cameras_ingest_check")
    op.execute(
        "ALTER TABLE cameras ADD CONSTRAINT cameras_ingest_check "
        "CHECK (ingest IN ('pull', 'push', 'usb'))"
    )
    op.execute(
        "ALTER TABLE cameras ADD CONSTRAINT cameras_usb_device_check "
        "CHECK (ingest <> 'usb' OR path IS NOT NULL)"
    )


def downgrade() -> None:
    op.execute("DELETE FROM cameras WHERE ingest = 'usb'")
    op.execute("ALTER TABLE cameras DROP CONSTRAINT cameras_usb_device_check")
    op.execute("ALTER TABLE cameras DROP CONSTRAINT cameras_ingest_check")
    op.execute(
        "ALTER TABLE cameras ADD CONSTRAINT cameras_ingest_check CHECK (ingest IN ('pull', 'push'))"
    )
