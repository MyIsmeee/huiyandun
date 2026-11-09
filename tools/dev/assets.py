"""场景资产库（设计 150 §8，REUSE-13）：从 Kenney 的 CC0 压缩包挑选模型，按 §4 材质色重新上色，
按类别合并为 glb，写出目录 web/console/public/models/catalog.json。

用法：uv run python tools/dev/assets.py <压缩包目录>
压缩包为 Kenney 官网下载的 <包名>.zip（如 city-kit-roads.zip），不入库；只取出用到的模型与调色板贴图。
glTF 的归中、合并、去重由 @gltf-transform/cli 完成（设计 150 §9A），本脚本只改颜色与写目录。
最后打印 deploy/third-party.yaml 的登记条目（C-RU-01），核对后替换其中的 Kenney 条目。

目录每项：id（场景数据中的资产编号）、category、name（中文名）、file（所在 glb，场景名即 id）、
footprint（占地格数 [x 向, z 向]，1 m 网格）、scale（模型单位换算为米）、yaw（先绕竖直轴转的角度）、
line（线状资产，按 len 沿 x 向铺设）。模型已归中、底面贴地；渲染时依次缩放、转 yaw、再转放置的 rot。
"""

import csv
import hashlib
import io
import json
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "web/console/public/models"
TIMEOUT_S = 120  # 单次 gltf-transform 调用上限
FIELDS = ("id", "category", "name", "file", "footprint", "scale", "yaw", "line")  # 目录每项的字段

# 类别：编号、中文名（场景页模型库的分组，设计 150 §6）
CATEGORIES = {
    "building": "建筑",
    "road": "道路",
    "wall": "墙与围栏",
    "opening": "门窗",
    "furniture": "家具",
    "equipment": "货架设备",
    "greenery": "绿化",
}

# 色板：(暗端, 亮端)，取自设计 150 §4 场景材质；原色按明度在两端之间取色，保留明暗层次、去掉色相
PALETTES = {
    "building": ("#CBD5E1", "#FFFFFF"),  # 屋顶 → 白墙
    "road": ("#DCDFE5", "#FFFFFF"),  # 路面 → 标线
    "furniture": ("#D4D4D8", "#E5E7EB"),  # 家具、货架 → 浅灰
    "tree": ("#B7C4B0", "#DDE5DA"),  # 树冠 → 草地
    "grass": ("#DDE5DA", "#DDE5DA"),
    "plaza": ("#E6E8EC", "#E6E8EC"),
}
# 原色明度 L* 低于 DARK 取暗端、高于 LIGHT 取亮端，之间线性过渡
DARK, LIGHT = 20.0, 90.0

# 包：压缩包名 → 模型所在目录
PACKS = {
    "city-kit-commercial": "Models/GLB format",
    "city-kit-industrial": "Models/GLB format",
    "city-kit-suburban": "Models/GLB format",
    "city-kit-roads": "Models/GLB format",
    "building-kit": "Models/GLB format",
    "factory-kit": "Models/GLB format",
    "furniture-kit": "Models/GLTF format",
}

# 挑选：(编号, 类别, 中文名, 包, 模型, 色板, 比例, 转角, 线状)
# 编号写入场景数据（SceneItem.asset），只增不改；比例把模型单位换成米；转角（度，绕竖直轴）把线状资产的
# 长边转到 x 轴；线状资产（墙、围栏、道路、传送带）按 len 沿 x 轴铺设
# fmt: off
SELECTION = [
    ("office-small", "building", "小办公楼", "city-kit-commercial", "building-a", "building", 8, 0, False),
    ("shop-low", "building", "低层商铺", "city-kit-commercial", "building-c", "building", 8, 0, False),
    ("shop-row", "building", "沿街商铺", "city-kit-commercial", "building-e", "building", 8, 0, False),
    ("office", "building", "办公楼", "city-kit-commercial", "building-j", "building", 8, 0, False),
    ("office-tall", "building", "高层办公楼", "city-kit-commercial", "building-l", "building", 8, 0, False),
    ("tower", "building", "塔楼", "city-kit-commercial", "building-skyscraper-a", "building", 8, 0, False),
    ("factory", "building", "厂房", "city-kit-industrial", "building-a", "building", 8, 0, False),
    ("factory-large", "building", "大厂房", "city-kit-industrial", "building-c", "building", 8, 0, False),
    ("warehouse", "building", "仓库", "city-kit-industrial", "building-q", "building", 8, 0, False),
    ("workshop", "building", "车间", "city-kit-industrial", "building-k", "building", 8, 0, False),
    ("house", "building", "住宅", "city-kit-suburban", "building-type-a", "building", 8, 0, False),
    ("house-large", "building", "两层住宅", "city-kit-suburban", "building-type-d", "building", 8, 0, False),
    ("road", "road", "道路", "city-kit-roads", "road-straight", "road", 8, 0, True),
    ("road-bend", "road", "道路转角", "city-kit-roads", "road-bend", "road", 8, 0, False),
    ("road-junction", "road", "丁字路口", "city-kit-roads", "road-intersection", "road", 8, 0, False),
    ("road-crossroad", "road", "十字路口", "city-kit-roads", "road-crossroad", "road", 8, 0, False),
    ("road-crosswalk", "road", "斑马线", "city-kit-roads", "road-crossing", "road", 8, 0, False),
    ("road-end", "road", "道路尽头", "city-kit-roads", "road-end", "road", 8, 0, False),
    ("road-entrance", "road", "出入口", "city-kit-roads", "road-driveway-single", "road", 8, 0, False),
    ("plaza", "road", "人行道、广场", "city-kit-roads", "tile-low", "plaza", 2, 0, False),
    ("wall", "wall", "墙", "building-kit", "wall", "building", 1, 90, True),
    ("wall-low", "wall", "矮墙", "building-kit", "wall-low", "building", 1, 90, True),
    ("fence", "wall", "围栏", "city-kit-suburban", "fence", "building", 4, 0, True),
    ("barrier", "wall", "施工围挡", "city-kit-roads", "construction-fence", "building", 8, 90, True),
    ("column", "wall", "柱", "building-kit", "column", "building", 1, 0, False),
    ("bollard", "wall", "隔离桩", "factory-kit", "warning-traffic", "building", 0.8, 0, False),
    ("wall-door", "opening", "门洞墙", "building-kit", "wall-doorway-square", "building", 1, 90, False),
    ("wall-door-wide", "opening", "宽门洞墙", "building-kit", "wall-doorway-wide-square", "building", 1, 90, False),
    ("wall-window", "opening", "窗墙", "building-kit", "wall-window-square", "building", 1, 90, False),
    ("wall-window-wide", "opening", "宽窗墙", "building-kit", "wall-window-wide-square", "building", 1, 90, False),
    ("desk", "furniture", "办公桌", "furniture-kit", "desk", "furniture", 2, 0, False),
    ("desk-corner", "furniture", "转角办公桌", "furniture-kit", "deskCorner", "furniture", 2, 0, False),
    ("office-chair", "furniture", "办公椅", "furniture-kit", "chairDesk", "furniture", 2, 0, False),
    ("chair", "furniture", "椅子", "furniture-kit", "chair", "furniture", 2, 0, False),
    ("table", "furniture", "桌子", "furniture-kit", "table", "furniture", 2, 0, False),
    ("coffee-table", "furniture", "茶几", "furniture-kit", "tableCoffee", "furniture", 2, 0, False),
    ("sofa", "furniture", "沙发", "furniture-kit", "loungeSofa", "furniture", 2, 0, False),
    ("sofa-corner", "furniture", "转角沙发", "furniture-kit", "loungeSofaCorner", "furniture", 2, 0, False),
    ("armchair", "furniture", "单人沙发", "furniture-kit", "loungeChair", "furniture", 2, 0, False),
    ("cabinet", "furniture", "文件柜", "furniture-kit", "bookcaseClosedDoors", "furniture", 2, 0, False),
    ("cabinet-wide", "furniture", "宽柜", "furniture-kit", "bookcaseClosedWide", "furniture", 2, 0, False),
    ("bed", "furniture", "单人床", "furniture-kit", "bedSingle", "furniture", 1.2, 0, False),
    ("bed-double", "furniture", "双人床", "furniture-kit", "bedDouble", "furniture", 1.4, 0, False),
    ("trash-can", "furniture", "垃圾桶", "furniture-kit", "trashcan", "furniture", 2, 0, False),
    ("shelf", "equipment", "货架", "furniture-kit", "bookcaseOpen", "furniture", 2.5, 0, False),
    ("rack", "equipment", "机柜", "factory-kit", "machine", "furniture", 1.25, 0, False),
    ("console", "equipment", "控制台", "factory-kit", "screen-panel-wide", "furniture", 1.25, 0, False),
    ("conveyor", "equipment", "传送带", "factory-kit", "conveyor", "furniture", 1.25, 0, True),
    ("crate", "equipment", "货箱", "factory-kit", "box-large", "furniture", 1.25, 0, False),
    ("robot-arm", "equipment", "机械臂", "factory-kit", "robot-arm-a", "furniture", 1.25, 0, False),
    ("scanner", "equipment", "安检机", "factory-kit", "scanner-high", "furniture", 1.25, 0, False),
    ("machine", "equipment", "加工设备", "factory-kit", "machine-bed", "furniture", 1.25, 0, False),
    ("tree", "greenery", "大树", "city-kit-suburban", "tree-large", "tree", 8, 0, False),
    ("tree-small", "greenery", "小树", "city-kit-suburban", "tree-small", "tree", 8, 0, False),
    ("planter", "greenery", "花坛", "city-kit-suburban", "planter", "tree", 8, 0, False),
    ("potted-plant", "greenery", "盆栽", "furniture-kit", "pottedPlant", "tree", 2, 0, False),
    ("grass", "greenery", "草地", "city-kit-roads", "tile-low", "grass", 2, 0, False),
]
# fmt: on


def hex_rgb(color: str) -> tuple[int, int, int]:
    return (int(color[1:3], 16), int(color[3:5], 16), int(color[5:7], 16))


def srgb_to_linear(c: float) -> float:
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def linear_to_srgb(c: float) -> float:
    return c * 12.92 if c <= 0.0031308 else 1.055 * c ** (1 / 2.4) - 0.055


def lightness(rgb: tuple[int, int, int]) -> float:
    """CIE L*（D65），0～100。"""
    r, g, b = (srgb_to_linear(c / 255) for c in rgb)
    y = 0.2126 * r + 0.7152 * g + 0.0722 * b
    return 116 * y ** (1 / 3) - 16 if y > 216 / 24389 else 24389 / 27 * y


def recolor(rgb: tuple[int, int, int], palette: str) -> tuple[int, int, int]:
    """按原色明度在色板两端之间线性取色。"""
    dark, light = (hex_rgb(c) for c in PALETTES[palette])
    t = min(max((lightness(rgb) - DARK) / (LIGHT - DARK), 0.0), 1.0)
    r, g, b = (round(lo + (hi - lo) * t) for lo, hi in zip(dark, light, strict=True))
    return (r, g, b)


def footprint(size: tuple[float, float], scale: float, yaw: int) -> list[int]:
    """占地格数 [x 向, z 向]（1 m 网格）：按比例与转角换算后向上取整，容差 5 cm，至少 1 格。"""
    w, d = (size[1], size[0]) if yaw % 180 else size
    return [max(1, int(-(-(v * scale - 0.05) // 1))) for v in (w, d)]


def gltf_transform(*args: str) -> str:
    cli = ["pnpm", "--dir", str(ROOT / "web/console"), "exec", "gltf-transform"]
    return subprocess.run(
        [*cli, *args], check=True, capture_output=True, text=True, timeout=TIMEOUT_S
    ).stdout


def extract(archive: zipfile.ZipFile, member: str, target: Path) -> None:
    """只按已知成员名读出、写到指定路径，不按压缩包内路径解压。"""
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(archive.read(member))


def recolor_gltf(path: Path, name: str, palette: str) -> None:
    """改调色板贴图与材质底色，去掉自发光（场景只用实体材质与固定光照，D-111）；场景改名为资产编号
    （合并后按场景名取用），并去掉节点与网格名：three.js 加载时节点、网格、场景共用一套名字，
    重名的会被加后缀，场景就按编号找不到了。"""
    doc = json.loads(path.read_text(encoding="utf-8"))
    doc["scenes"][doc.get("scene", 0)]["name"] = name
    for item in doc["nodes"] + doc["meshes"]:
        item.pop("name", None)
    for image in doc.get("images", []):
        file = path.parent / image["uri"]
        with Image.open(file) as im:
            rgba = im.convert("RGBA")
        cache: dict[tuple[int, ...], tuple[int, ...]] = {}
        pixels = [
            cache.setdefault(p, (*recolor(p[:3], palette), p[3])) for p in rgba.get_flattened_data()
        ]
        rgba.putdata(pixels)
        rgba.save(file)
    for material in doc.get("materials", []):
        material.pop("emissiveFactor", None)
        material.pop("emissiveTexture", None)
        pbr = material.setdefault("pbrMetallicRoughness", {})
        if "baseColorFactor" in pbr:
            *rgb, alpha = pbr["baseColorFactor"]
            r, g, b = (round(linear_to_srgb(c) * 255) for c in rgb)
            color = [srgb_to_linear(c / 255) for c in recolor((r, g, b), palette)]
            pbr["baseColorFactor"] = [*color, alpha]
    path.write_text(json.dumps(doc), encoding="utf-8")


def scene_sizes(glb: Path) -> dict[str, tuple[float, float]]:
    """各场景包围盒的 x、z 尺寸（模型单位），取自 gltf-transform inspect 的 SCENES 表。"""
    rows = list(csv.reader(io.StringIO(gltf_transform("inspect", str(glb), "--format", "csv"))))
    header = next(i for i, r in enumerate(rows) if r[:3] == ["#", "name", "rootName"])
    sizes = {}
    for row in rows[header + 1 :]:
        if len(row) < 5:
            break
        lo, hi = ([float(v) for v in cell.split(",")] for cell in row[3:5])
        sizes[row[1]] = (hi[0] - lo[0], hi[2] - lo[2])
    return sizes


def pack_version(archive: zipfile.ZipFile) -> str:
    """License.txt 首行形如 "Building Kit (1.0)"。"""
    first = archive.read("License.txt").decode("utf-8").strip().splitlines()[0]
    return first.rsplit("(", 1)[1].rstrip(")")


def build(archives: Path, work: Path) -> list[dict]:
    zips = {pack: zipfile.ZipFile(archives / f"{pack}.zip") for pack in PACKS}
    staged: dict[str, list[Path]] = {c: [] for c in CATEGORIES}
    for name, category, _, pack, model, palette, *_ in SELECTION:
        source = work / "src" / pack / f"{model}.glb"
        if not source.exists():
            extract(zips[pack], f"{PACKS[pack]}/{model}.glb", source)
            texture = f"{PACKS[pack]}/Textures/colormap.png"
            if texture in zips[pack].namelist():
                extract(zips[pack], texture, source.parent / "Textures/colormap.png")
        staged_file = work / "staged" / name / f"{name}.gltf"
        staged_file.parent.mkdir(parents=True)
        gltf_transform("center", str(source), str(staged_file), "--pivot", "below")
        recolor_gltf(staged_file, name, palette)
        staged[category].append(staged_file)
    catalog = []
    for category, files in staged.items():
        glb = OUT / f"scene-{category}.glb"
        gltf_transform("merge", *map(str, files), str(glb))
        gltf_transform("dedup", str(glb), str(glb))
        gltf_transform("prune", str(glb), str(glb))
        sizes = scene_sizes(glb)
        for name, cat, label, _, _, _, scale, yaw, line in SELECTION:
            if cat == category:
                size = footprint(sizes[name], scale, yaw)
                values = (name, category, label, glb.name, size, scale, yaw, line)
                catalog.append(dict(zip(FIELDS, values, strict=True)))
    versions = {pack: pack_version(z) for pack, z in zips.items()}
    for z in zips.values():
        z.close()
    print(registry(versions))
    return catalog


def registry(versions: dict[str, str]) -> str:
    """deploy/third-party.yaml 的登记条目：每个类别文件一条，models 逐个列出来源模型。"""
    lines = []
    for category, label in CATEGORIES.items():
        glb = OUT / f"scene-{category}.glb"
        picked = [s for s in SELECTION if s[1] == category]
        packs = sorted({s[3] for s in picked})
        lines += [
            f"  - name: Kenney 场景资产 · {label}",
            f"    file: {glb.relative_to(ROOT).as_posix()}",
            f"    sha256: {hashlib.sha256(glb.read_bytes()).hexdigest()}",
            "    license: CC0-1.0",
            "    source: Kenney 官网 "
            + "、".join(f"{p} {versions[p]}" for p in packs)
            + "（tools/dev/assets.py 归中、重新上色、合并）",
            f"    purpose: 场景搭建模型库 · {label}（设计 150 §8）",
            "    owner: MyIsmeee",
            "    models:",
            *(f"      - {{ id: {s[0]}, source: {s[3]}/{s[4]} }}" for s in picked),
        ]
    return "\n".join(lines)


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    for old in OUT.glob("scene-*.glb"):
        old.unlink()
    with tempfile.TemporaryDirectory() as tmp:
        catalog = build(Path(sys.argv[1]), Path(tmp))
    categories = [{"id": c, "name": n} for c, n in CATEGORIES.items()]
    rows = ",\n  ".join(json.dumps(a, ensure_ascii=False) for a in catalog)
    head = json.dumps(categories, ensure_ascii=False)
    text = f'{{\n "categories": {head},\n "assets": [\n  {rows}\n ]\n}}\n'
    (OUT / "catalog.json").write_text(text, encoding="utf-8")


if __name__ == "__main__":
    main()
