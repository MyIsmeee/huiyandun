"""前端场景资产（REUSE-13，设计 150 §8）：web/console/public/models/ 下的模型逐一登记于
deploy/third-party.yaml，资产目录 catalog.json 与模型文件一致。"""

import hashlib
import json
import re
import struct
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
MODELS = ROOT / "web/console/public/models"
CATALOG = json.loads((MODELS / "catalog.json").read_text(encoding="utf-8"))
REGISTRY = yaml.safe_load((ROOT / "deploy/third-party.yaml").read_text(encoding="utf-8"))
MAX_BYTES = 8 * 1024 * 1024  # 资产随代码提交，总量 ≤ 8 MB（设计 150 §8）
ASSET_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")  # 契约 SceneItem.asset


def gltf_json(path: Path) -> dict:
    """GLB 的 JSON 块：12 字节文件头之后为块长度、块类型与内容。"""
    data = path.read_bytes()
    (length,) = struct.unpack("<I", data[12:16])
    return json.loads(data[20 : 20 + length])


def test_scene_assets_registered() -> None:
    """C-RU-01、G-08：每个模型文件都已登记、哈希一致，许可为 CC0；目录是自有文件，不登记。"""
    registered = {a["file"]: a["sha256"] for a in REGISTRY["assets"]}
    files = {
        p.relative_to(ROOT).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in MODELS.iterdir()
        if p.name != "catalog.json"
    }
    assert files == registered
    assert {a["license"] for a in REGISTRY["assets"]} == {"CC0-1.0"}


def test_catalog_models_registered_one_by_one() -> None:
    """合并文件中的每个模型逐个登记来源（C-RU-01），登记与目录一一对应。"""
    registered = {
        (Path(a["file"]).name, m["id"]) for a in REGISTRY["assets"] for m in a.get("models", [])
    }
    assert registered == {(a["file"], a["id"]) for a in CATALOG["assets"]}


def test_catalog_matches_model_files() -> None:
    """每个资产都能在所在 glb 中按场景名取到；glb 中没有目录外的场景，也没有会与场景重名的节点、网格名。"""
    for file in {a["file"] for a in CATALOG["assets"]}:
        doc = gltf_json(MODELS / file)
        scenes = [s.get("name") for s in doc["scenes"]]
        assert sorted(scenes) == sorted(a["id"] for a in CATALOG["assets"] if a["file"] == file)
        assert not [x for x in doc["nodes"] + doc["meshes"] if "name" in x]


def test_catalog_fields() -> None:
    ids = [a["id"] for a in CATALOG["assets"]]
    assert len(ids) == len(set(ids))
    categories = {c["id"] for c in CATALOG["categories"]}
    for asset in CATALOG["assets"]:
        assert ASSET_ID.match(asset["id"]), asset["id"]
        assert asset["category"] in categories
        assert asset["name"]
        assert len(asset["footprint"]) == 2 and min(asset["footprint"]) >= 1
        assert asset["scale"] > 0
        assert asset["yaw"] in (0, 90, 180, 270)
        assert isinstance(asset["line"], bool)
    assert categories == {a["category"] for a in CATALOG["assets"]}


def test_models_total_size() -> None:
    assert sum(p.stat().st_size for p in MODELS.iterdir()) <= MAX_BYTES
