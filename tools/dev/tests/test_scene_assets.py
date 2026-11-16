"""场景资产库脚本（设计 150 §8）：重新上色与占地格数的换算。"""

import importlib.util
import json
import struct
from pathlib import Path

import pytest
import yaml

SCRIPT = Path(__file__).resolve().parents[1] / "assets.py"
_spec = importlib.util.spec_from_file_location("assets", SCRIPT)
assert _spec and _spec.loader
assets = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(assets)


def test_recolor_maps_lightness_into_palette() -> None:
    """深色取暗端、浅色取亮端，中间按明度过渡；鲜艳的原色也只落在两端之间（去掉色相）。"""
    dark, light = (assets.hex_rgb(c) for c in assets.PALETTES["building"])
    assert assets.recolor((0, 0, 0), "building") == dark
    assert assets.recolor((255, 255, 255), "building") == light
    mid = assets.recolor((119, 119, 119), "building")  # L* 约 50
    assert all(lo < m < hi for lo, m, hi in zip(dark, mid, light, strict=True))
    for vivid in ((230, 40, 40), (40, 200, 60), (60, 90, 230), (250, 180, 25)):
        out = assets.recolor(vivid, "building")
        assert all(lo <= o <= hi for lo, o, hi in zip(dark, out, light, strict=True))
    assert assets.recolor((230, 40, 40), "plaza") == assets.hex_rgb("#E6E8EC")


def test_palettes_are_scene_materials() -> None:
    """色板两端只用设计 150 §4 的场景材质色（配色校验 V-S5 已覆盖这些颜色）。"""
    materials = {
        "#EEF0F3", "#DCDFE5", "#FFFFFF", "#E6E8EC", "#DDE5DA",
        "#E5E7EB", "#CBD5E1", "#D4D4D8", "#B7C4B0",
    }  # fmt: skip
    assert {c for pair in assets.PALETTES.values() for c in pair} <= materials


def test_footprint_rounds_up_and_follows_yaw() -> None:
    assert assets.footprint((0.9, 0.94), 8, 0) == [8, 8]  # 7.2 m、7.52 m → 8 格
    assert assets.footprint((0.1, 2.0), 1, 90) == [2, 1]  # 墙沿 z，转 90° 后长边沿 x
    assert assets.footprint((1.0, 1.0), 2.02, 0) == [2, 2]  # 2.02 m 在 5 cm 容差内
    assert assets.footprint((0.01, 0.01), 1, 0) == [1, 1]


def box_glb(path: Path, size: tuple[float, float, float], color: list[float]) -> None:
    """最小的 glb：一个长方体、一种基础色，带自发光与节点名，模拟 Blender 导出。"""
    w, h, d = size
    xs, ys, zs = (-w / 2, w / 2), (0.3, 0.3 + h), (-d / 2, d / 2)  # 底面不在 y=0：须由脚本贴地
    points = [(x, y, z) for x in xs for y in ys for z in zs]
    faces = [(0, 1, 3), (0, 3, 2), (4, 6, 7), (4, 7, 5), (0, 4, 5), (0, 5, 1),
             (2, 3, 7), (2, 7, 6), (0, 2, 6), (0, 6, 4), (1, 5, 7), (1, 7, 3)]  # fmt: skip
    positions = struct.pack(f"<{len(points) * 3}f", *[c for p in points for c in p])
    indices = struct.pack(f"<{len(faces) * 3}H", *[i for f in faces for i in f])
    buffer = positions + indices
    doc = {
        "asset": {"version": "2.0", "generator": "Khronos glTF Blender I/O"},
        "scene": 0,
        "scenes": [{"name": "Scene", "nodes": [0]}],
        "nodes": [{"name": "Cube", "mesh": 0}],
        "meshes": [{"name": "Cube", "primitives": [
            {"attributes": {"POSITION": 0}, "indices": 1, "material": 0}]}],
        "materials": [{"name": "Material", "emissiveFactor": [1, 1, 1],
                       "pbrMetallicRoughness": {"baseColorFactor": [*color, 1]}}],
        "accessors": [
            {"bufferView": 0, "componentType": 5126, "count": len(points), "type": "VEC3",
             "min": [xs[0], ys[0], zs[0]], "max": [xs[1], ys[1], zs[1]]},
            {"bufferView": 1, "componentType": 5123, "count": len(faces) * 3, "type": "SCALAR"},
        ],
        "bufferViews": [
            {"buffer": 0, "byteOffset": 0, "byteLength": len(positions)},
            {"buffer": 0, "byteOffset": len(positions), "byteLength": len(indices)},
        ],
        "buffers": [{"byteLength": len(buffer)}],
    }  # fmt: skip
    text = json.dumps(doc).encode()
    text += b" " * (-len(text) % 4)
    buffer += b"\0" * (-len(buffer) % 4)
    chunks = struct.pack("<II", len(text), 0x4E4F534A) + text
    chunks += struct.pack("<II", len(buffer), 0x004E4942) + buffer
    path.write_bytes(struct.pack("<III", 0x46546C67, 2, 12 + len(chunks)) + chunks)


def gltf_json(path: Path) -> dict:
    data = path.read_bytes()
    (length,) = struct.unpack("<I", data[12:16])
    return json.loads(data[20 : 20 + length])


def custom_dir(tmp_path: Path, models: list[dict]) -> Path:
    directory = tmp_path / "custom"
    directory.mkdir()
    (directory / "models.yaml").write_text(yaml.safe_dump({"models": models}), encoding="utf-8")
    return directory


GATE = {
    "id": "gate",
    "category": "equipment",
    "name": "道闸",
    "palette": "furniture",
    "author": "队员",
}


def test_custom_manifest_reports_every_error(tmp_path: Path) -> None:
    """清单出错时一次列出全部问题：编号、类别、色板、作者、转角、文件、与 Kenney 编号冲突。"""
    directory = custom_dir(tmp_path, [
        {"id": "Bad_ID", "category": "vehicle", "palette": "neon", "name": "x", "yaw": 45},
        {**GATE, "id": "office"},
    ])  # fmt: skip

    with pytest.raises(SystemExit) as exc:
        assets.load_custom(directory, {"office"})

    message = str(exc.value)
    for expected in ("第 1 项：id", "第 1 项：category", "第 1 项：palette", "第 1 项：缺少作者",
                     "第 1 项：yaw", "第 1 项：找不到模型文件", "第 2 项：id office 已被占用"):  # fmt: skip
        assert expected in message


def test_custom_manifest_empty_builds_nothing(tmp_path: Path) -> None:
    directory = custom_dir(tmp_path, [])

    assert assets.build_custom(directory, tmp_path, tmp_path / "work", set()) == []
    assert not (tmp_path / assets.CUSTOM_GLB).exists()


def test_custom_models_merged_like_kenney(tmp_path: Path) -> None:
    """自制模型经 gltf-transform 归中贴地、重新上色并合并：场景名即编号，无节点与网格名、无自发光。"""
    directory = custom_dir(tmp_path, [
        GATE,
        {"id": "fence-panel", "category": "wall", "name": "围栏", "palette": "furniture",
         "author": "队员", "file": "fence.glb", "yaw": 90, "line": True},
    ])  # fmt: skip
    box_glb(directory / "gate.glb", (2.5, 1.2, 0.4), [0.8, 0.1, 0.1])
    box_glb(directory / "fence.glb", (0.1, 1.5, 2.0), [0.1, 0.6, 0.2])
    out = tmp_path / "out"
    out.mkdir()

    catalog = assets.build_custom(directory, out, tmp_path / "work", {"office"})

    assert catalog == [
        {"id": "gate", "category": "equipment", "name": "道闸", "file": "scene-custom.glb",
         "footprint": [3, 1], "scale": 1, "yaw": 0, "line": False},
        {"id": "fence-panel", "category": "wall", "name": "围栏", "file": "scene-custom.glb",
         "footprint": [2, 1], "scale": 1, "yaw": 90, "line": True},
    ]  # fmt: skip
    doc = gltf_json(out / assets.CUSTOM_GLB)
    assert sorted(s["name"] for s in doc["scenes"]) == ["fence-panel", "gate"]
    assert not [x for x in doc["nodes"] + doc["meshes"] if "name" in x]
    assert not [m for m in doc["materials"] if "emissiveFactor" in m]
    dark, light = (assets.hex_rgb(c) for c in assets.PALETTES["furniture"])
    for material in doc["materials"]:
        rgb = [round(assets.linear_to_srgb(c) * 255) for c in
               material["pbrMetallicRoughness"]["baseColorFactor"][:3]]  # fmt: skip
        assert all(lo <= c <= hi for lo, c, hi in zip(dark, rgb, light, strict=True))
    # 归中写在根节点的平移上（gltf-transform center 不改顶点）：顶点最低点加平移即世界坐标的底面
    for scene in doc["scenes"]:
        [root] = (doc["nodes"][n] for n in scene["nodes"])
        position = doc["meshes"][root["mesh"]]["primitives"][0]["attributes"]["POSITION"]
        bottom = doc["accessors"][position]["min"][1] + root.get("translation", [0, 0, 0])[1]
        assert abs(bottom) < 1e-6  # 底面贴地
