"""场景区域（D-124、TK-152）：管理员搭建的 3D 场景，摄像头归属某个区域。

保留策略（C-ST-02）：配置数据，随管理员删除区域而删除；区域内仍有摄像头时不可删除。
编号由序列 scene_area_id_seq 分配，只增不复用。序列从未分配过编号即首次启动（含从无区域的版本升级）：
api-server 此时按 site.yaml 的尺寸建"默认区域"并放入现有摄像头（scene.ensure_default_area）。
"""

from alembic import op

revision = "0011"
down_revision = "0010"


def upgrade() -> None:
    op.execute("""
        CREATE TABLE scene_areas (
            id text PRIMARY KEY,
            name text NOT NULL,
            width_m integer NOT NULL CHECK (width_m BETWEEN 1 AND 500),
            depth_m integer NOT NULL CHECK (depth_m BETWEEN 1 AND 500),
            items jsonb NOT NULL,
            updated_at timestamptz NOT NULL
        )
    """)
    op.execute("GRANT SELECT, INSERT, UPDATE, DELETE ON scene_areas TO hyd_app")
    op.execute("CREATE SEQUENCE scene_area_id_seq MINVALUE 1")
    op.execute("GRANT USAGE, SELECT, UPDATE ON SEQUENCE scene_area_id_seq TO hyd_app")
    op.execute("ALTER TABLE cameras ADD COLUMN area_id text REFERENCES scene_areas (id)")


def downgrade() -> None:
    op.execute("ALTER TABLE cameras DROP COLUMN area_id")
    op.execute("DROP SEQUENCE scene_area_id_seq")
    op.execute("DROP TABLE scene_areas")
