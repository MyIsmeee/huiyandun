"""摄像头标定误差（D-132、TK-163）：保存标定时拟合的均方根重投影误差（米）。

经 site.yaml 导入的标定没有该值，为 null；清除标定或换区域时一并清空。
"""

from alembic import op

revision = "0012"
down_revision = "0011"


def upgrade() -> None:
    op.execute("ALTER TABLE cameras ADD COLUMN calibration_error_m double precision")


def downgrade() -> None:
    op.execute("ALTER TABLE cameras DROP COLUMN calibration_error_m")
