"""场景区域（D-124、TK-152）：管理员搭建的 3D 场景，摄像头归属某个区域。

保留策略（C-ST-02）：配置数据，随管理员删除区域而删除；区域内仍有摄像头时不可删除。
编号由序列 scene_area_id_seq 分配，只增不复用。scene_bootstrap.default_area_done 为 false 即首次启动（含从无区域的
版本升级）：api-server 此时按 site.yaml 的尺寸建"默认区域"并放入现有摄像头，与置为 true 在同一事务内
（scene.ensure_default_area）。不用序列判断：序列不随事务回滚，建到一半失败会被误认为已建过。
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
    op.execute("GRANT USAGE, UPDATE ON SEQUENCE scene_area_id_seq TO hyd_app")
    op.execute("ALTER TABLE cameras ADD COLUMN area_id text REFERENCES scene_areas (id)")
    op.execute("CREATE TABLE scene_bootstrap (default_area_done boolean NOT NULL)")
    op.execute("INSERT INTO scene_bootstrap VALUES (false)")
    op.execute("GRANT SELECT, UPDATE ON scene_bootstrap TO hyd_app")


def downgrade() -> None:
    op.execute("DROP TABLE scene_bootstrap")
    op.execute("ALTER TABLE cameras DROP COLUMN area_id")
    op.execute("DROP SEQUENCE scene_area_id_seq")
    op.execute("DROP TABLE scene_areas")
