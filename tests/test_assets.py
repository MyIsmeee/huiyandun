"""前端场景资产（REUSE-13）：web/console/public/models/ 下的文件逐一登记于 deploy/third-party.yaml。"""

import hashlib
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]


def test_scene_assets_registered() -> None:
    """C-RU-01、G-08：每个模型文件都已登记、哈希一致，许可为 CC0。"""
    registry = yaml.safe_load((ROOT / "deploy/third-party.yaml").read_text(encoding="utf-8"))
    registered = {a["file"]: a["sha256"] for a in registry["assets"]}
    files = {
        p.relative_to(ROOT).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in (ROOT / "web/console/public/models").iterdir()
    }
    assert files == registered
    assert {a["license"] for a in registry["assets"]} == {"CC0-1.0"}
