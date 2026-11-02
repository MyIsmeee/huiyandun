"""报告引用的值班员判定（D-089、TK-116）：生成时的快照，随报告插入，hyd_app 不可更新。"""

from alembic import op

revision = "0008"
down_revision = "0007"


def upgrade() -> None:
    op.execute("ALTER TABLE report ADD COLUMN investigation jsonb")


def downgrade() -> None:
    op.execute("ALTER TABLE report DROP COLUMN investigation")
