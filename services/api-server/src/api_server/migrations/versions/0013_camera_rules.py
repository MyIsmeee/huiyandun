"""摄像头轨迹规则（区域入侵、有向越线）：几何为所在场景区域的平面坐标（米），随登记表下发给 vision-engine。"""

from alembic import op

revision = "0013"
down_revision = "0012"


def upgrade() -> None:
    op.execute("ALTER TABLE cameras ADD COLUMN rules jsonb NOT NULL DEFAULT '[]'::jsonb")


def downgrade() -> None:
    op.execute("ALTER TABLE cameras DROP COLUMN rules")
