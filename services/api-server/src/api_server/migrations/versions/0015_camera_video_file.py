"""视频文件摄像头（D-145）：ingest 循环播放上传的视频。path 存上传编号（卷中的文件名），file_name 为原始文件名。"""

from alembic import op

revision = "0015"
down_revision = "0014"


def upgrade() -> None:
    op.execute("ALTER TABLE cameras ADD COLUMN file_name text")
    op.execute("ALTER TABLE cameras DROP CONSTRAINT cameras_ingest_check")
    op.execute(
        "ALTER TABLE cameras ADD CONSTRAINT cameras_ingest_check "
        "CHECK (ingest IN ('pull', 'push', 'usb', 'file'))"
    )
    op.execute(
        "ALTER TABLE cameras ADD CONSTRAINT cameras_file_check "
        "CHECK (ingest <> 'file' OR (path IS NOT NULL AND file_name IS NOT NULL))"
    )


def downgrade() -> None:
    op.execute("DELETE FROM cameras WHERE ingest = 'file'")
    op.execute("ALTER TABLE cameras DROP CONSTRAINT cameras_file_check")
    op.execute("ALTER TABLE cameras DROP CONSTRAINT cameras_ingest_check")
    op.execute(
        "ALTER TABLE cameras ADD CONSTRAINT cameras_ingest_check "
        "CHECK (ingest IN ('pull', 'push', 'usb'))"
    )
    op.execute("ALTER TABLE cameras DROP COLUMN file_name")
