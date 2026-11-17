"""场景资产库（设计 150 §8，REUSE-13）：从 Kenney 的 CC0 压缩包挑选模型，按 §4 材质色重新上色，
按类别合并为 glb，写出目录 web/console/public/models/catalog.json。

用法：
  uv run python tools/dev/assets.py <压缩包目录>   全部重建（Kenney 与自制模型）
  uv run python tools/dev/assets.py --custom        只重建自制模型，目录中的 Kenney 条目保持不变
  uv run python tools/dev/assets.py --only <包名>=<压缩包或解压目录> ...
                                                    只重建模型全部来自给出的包的类别，其余类别与自制模型保持不变
压缩包为 Kenney 官网下载的 <包名>.zip（如 city-kit-roads.zip），不入库；只取出用到的模型与调色板贴图。
也可给出解压后的目录（如 furniture-kit=~/Downloads/kenney_furniture-kit）：同样只按已知成员名读取。

自制模型（如 Blender 导出的 glb）：源文件与登记清单 models.yaml 放在 web/console/assets/custom/（随代码提交，
不经前端发布），归中、上色方式与 Kenney 模型相同，合并为单独的 scene-custom.glb，类别取已有类别。
只放团队自制的模型；第三方模型须挑选进 SELECTION 并登记 deploy/third-party.yaml（C-RU-01）。
清单格式与导出要求见该目录的 README.md。
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
import re
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path
from typing import Any

import yaml
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "web/console/public/models"
CUSTOM_DIR = ROOT / "web/console/assets/custom"  # 自制模型源文件与清单 models.yaml
CUSTOM_GLB = "scene-custom.glb"  # 自制模型合并后的文件，与 Kenney 的类别文件分开，单独重建不动后者
ASSET_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")  # 契约 SceneItem.asset
YAWS = (0, 90, 180, 270)
TIMEOUT_S = 120  # 单次 gltf-transform 调用上限
FIELDS = ("id", "category", "name", "file", "footprint", "scale", "yaw", "line")  # 目录每项的字段

# 类别：编号、中文名（场景页模型库的分组，设计 150 §6）
CATEGORIES = {
    "building": "建筑",
    "road": "道路",
    "wall": "墙与围栏",
    "opening": "门窗",
    "furniture": "家具",
    "appliance": "办公与电器",
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
    # 2026-11-17 扩充：常见办公室、宿舍、茶水间家具（同一 furniture-kit 2.0）
    ("bookcase", "furniture", "书柜", "furniture-kit", "bookcaseClosed", "furniture", 2, 0, False),
    ("bookcase-low", "furniture", "矮书架", "furniture-kit", "bookcaseOpenLow", "furniture", 2, 0, False),
    ("side-table", "furniture", "边桌", "furniture-kit", "sideTable", "furniture", 2, 0, False),
    ("drawer-cabinet", "furniture", "抽屉柜", "furniture-kit", "sideTableDrawers", "furniture", 2, 0, False),
    ("table-round", "furniture", "圆桌", "furniture-kit", "tableRound", "furniture", 2, 0, False),
    ("table-glass", "furniture", "玻璃桌", "furniture-kit", "tableGlass", "furniture", 2, 0, False),
    ("table-cloth", "furniture", "会议桌", "furniture-kit", "tableCloth", "furniture", 2, 0, False),
    ("chair-rounded", "furniture", "圆背椅", "furniture-kit", "chairRounded", "furniture", 2, 0, False),
    ("chair-cushion", "furniture", "软垫椅", "furniture-kit", "chairCushion", "furniture", 2, 0, False),
    ("chair-modern", "furniture", "现代椅", "furniture-kit", "chairModernCushion", "furniture", 2, 0, False),
    ("stool", "furniture", "吧凳", "furniture-kit", "stoolBar", "furniture", 2, 0, False),
    ("bench", "furniture", "长凳", "furniture-kit", "bench", "furniture", 2, 0, False),
    ("sofa-long", "furniture", "长沙发", "furniture-kit", "loungeSofaLong", "furniture", 2, 0, False),
    ("sofa-design", "furniture", "布艺沙发", "furniture-kit", "loungeDesignSofa", "furniture", 2, 0, False),
    ("lounge-chair", "furniture", "休闲椅", "furniture-kit", "loungeChairRelax", "furniture", 2, 0, False),
    ("bed-bunk", "furniture", "上下铺", "furniture-kit", "bedBunk", "furniture", 2, 0, False),
    ("coat-rack", "furniture", "衣帽架", "furniture-kit", "coatRackStanding", "furniture", 2, 0, False),
    ("box", "furniture", "纸箱", "furniture-kit", "cardboardBoxClosed", "furniture", 2, 0, False),
    ("box-open", "furniture", "开口纸箱", "furniture-kit", "cardboardBoxOpen", "furniture", 2, 0, False),
    ("plant-small", "furniture", "小盆栽", "furniture-kit", "plantSmall1", "furniture", 2, 0, False),
    ("rug", "furniture", "地毯", "furniture-kit", "rugRectangle", "furniture", 2, 0, False),
    ("rug-round", "furniture", "圆地毯", "furniture-kit", "rugRound", "furniture", 2, 0, False),
    ("kitchen-cabinet", "furniture", "橱柜", "furniture-kit", "kitchenCabinet", "furniture", 2, 0, False),
    ("kitchen-bar", "furniture", "吧台", "furniture-kit", "kitchenBar", "furniture", 2, 0, False),
    ("kitchen-sink", "furniture", "水槽", "furniture-kit", "kitchenSink", "furniture", 2, 0, False),
    ("toilet", "furniture", "马桶", "furniture-kit", "toilet", "furniture", 2, 0, False),
    ("bathroom-sink", "furniture", "洗手台", "furniture-kit", "bathroomSink", "furniture", 2, 0, False),
    ("shower", "furniture", "淋浴间", "furniture-kit", "shower", "furniture", 2, 0, False),
    # 办公与电器（同一 furniture-kit 2.0）
    ("monitor", "appliance", "显示器", "furniture-kit", "computerScreen", "furniture", 2, 0, False),
    ("laptop", "appliance", "笔记本电脑", "furniture-kit", "laptop", "furniture", 2, 0, False),
    ("keyboard", "appliance", "键盘", "furniture-kit", "computerKeyboard", "furniture", 2, 0, False),
    ("tv", "appliance", "电视", "furniture-kit", "televisionModern", "furniture", 2, 0, False),
    ("tv-cabinet", "appliance", "电视柜", "furniture-kit", "cabinetTelevision", "furniture", 2, 0, False),
    ("speaker", "appliance", "音箱", "furniture-kit", "speaker", "furniture", 2, 0, False),
    ("fridge", "appliance", "冰箱", "furniture-kit", "kitchenFridge", "furniture", 2, 0, False),
    ("fridge-small", "appliance", "小冰箱", "furniture-kit", "kitchenFridgeSmall", "furniture", 2, 0, False),
    ("microwave", "appliance", "微波炉", "furniture-kit", "kitchenMicrowave", "furniture", 2, 0, False),
    ("coffee-machine", "appliance", "咖啡机", "furniture-kit", "kitchenCoffeeMachine", "furniture", 2, 0, False),
    ("washer", "appliance", "洗衣机", "furniture-kit", "washer", "furniture", 2, 0, False),
    ("lamp-floor", "appliance", "落地灯", "furniture-kit", "lampSquareFloor", "furniture", 2, 0, False),
    ("lamp-table", "appliance", "台灯", "furniture-kit", "lampRoundTable", "furniture", 2, 0, False),
    ("ceiling-fan", "appliance", "吊扇", "furniture-kit", "ceilingFan", "furniture", 2, 0, False),
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


class FolderPack:
    """已解压的 Kenney 包目录：与压缩包一样只按已知成员名读取，成员名不得跳出该目录。"""

    def __init__(self, root: Path) -> None:
        self._root = root.resolve()

    def _path(self, member: str) -> Path:
        path = (self._root / member).resolve()
        if self._root not in path.parents:
            raise ValueError(f"成员 {member} 不在包目录内")
        return path

    def read(self, member: str) -> bytes:
        return self._path(member).read_bytes()

    def has(self, member: str) -> bool:
        return self._path(member).is_file()

    def close(self) -> None:
        pass


class ZipPack:
    def __init__(self, path: Path) -> None:
        self._zip = zipfile.ZipFile(path)

    def read(self, member: str) -> bytes:
        return self._zip.read(member)

    def has(self, member: str) -> bool:
        return member in self._zip.namelist()

    def close(self) -> None:
        self._zip.close()


type Pack = FolderPack | ZipPack


def open_pack(path: Path) -> Pack:
    return FolderPack(path) if path.is_dir() else ZipPack(path)


def extract(archive: Pack, member: str, target: Path) -> None:
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


def pack_version(archive: Pack) -> str:
    """License.txt 首行形如 "Building Kit (1.0)"。"""
    first = archive.read("License.txt").decode("utf-8").strip().splitlines()[0]
    return first.rsplit("(", 1)[1].rstrip(")")


def stage(source: Path, work: Path, name: str, palette: str) -> Path:
    """归中、底面贴地并重新上色，写成 work/staged/<编号>/<编号>.gltf（贴图与缓冲为同目录的外部文件）。"""
    staged_file = work / "staged" / name / f"{name}.gltf"
    staged_file.parent.mkdir(parents=True)
    gltf_transform("center", str(source), str(staged_file), "--pivot", "below")
    recolor_gltf(staged_file, name, palette)
    return staged_file


def merge(files: list[Path], glb: Path) -> dict[str, tuple[float, float]]:
    """合并为一个 glb（每个模型一个场景）并去重、清理，返回各场景的 x、z 尺寸。"""
    gltf_transform("merge", *map(str, files), str(glb))
    gltf_transform("dedup", str(glb), str(glb))
    gltf_transform("prune", str(glb), str(glb))
    return scene_sizes(glb)


def entry(
    name: str, category: str, label: str, file: str, size: tuple[float, float], scale: float,
    yaw: int, line: bool,
) -> dict:  # fmt: skip
    values = (name, category, label, file, footprint(size, scale, yaw), scale, yaw, line)
    return dict(zip(FIELDS, values, strict=True))


def rebuildable(packs: set[str]) -> list[str]:
    """模型全部来自给出的包的类别（按 CATEGORIES 顺序）。"""
    return [c for c in CATEGORIES if {s[3] for s in SELECTION if s[1] == c} <= packs]


def build(sources: dict[str, Path], work: Path) -> list[dict]:
    """重建模型全部来自 sources（包名 → 压缩包或解压目录）的类别，返回这些类别的目录条目。"""
    zips = {pack: open_pack(path) for pack, path in sources.items()}
    categories = rebuildable(set(sources))
    staged: dict[str, list[Path]] = {c: [] for c in categories}
    for name, category, _, pack, model, palette, *_ in SELECTION:
        if category not in staged:
            continue
        source = work / "src" / pack / f"{model}.glb"
        if not source.exists():
            extract(zips[pack], f"{PACKS[pack]}/{model}.glb", source)
            texture = f"{PACKS[pack]}/Textures/colormap.png"
            if zips[pack].has(texture):
                extract(zips[pack], texture, source.parent / "Textures/colormap.png")
        staged[category].append(stage(source, work, name, palette))
    catalog = []
    for category, files in staged.items():
        glb = OUT / f"scene-{category}.glb"
        sizes = merge(files, glb)
        for name, cat, label, _, _, _, scale, yaw, line in SELECTION:
            if cat == category:
                catalog.append(
                    entry(name, category, label, glb.name, sizes[name], scale, yaw, line)
                )
    versions = {pack: pack_version(z) for pack, z in zips.items()}
    for z in zips.values():
        z.close()
    print(registry(versions, categories))
    return catalog


def load_custom(directory: Path, taken: set[str]) -> list[dict[str, Any]]:
    """读取并校验自制模型清单；taken 为 Kenney 资产已用的编号。出错时列出全部问题后退出。"""
    manifest = directory / "models.yaml"
    models = (yaml.safe_load(manifest.read_text(encoding="utf-8")) or {}).get("models") or []
    errors, seen = [], set(taken)
    for i, model in enumerate(models, 1):
        where = f"models.yaml 第 {i} 项"
        name = model.get("id", "")
        if not isinstance(name, str) or not ASSET_ID.match(name):
            errors.append(f"{where}：id 须为小写字母、数字与连字符（契约 SceneItem.asset）")
        elif name in seen:
            errors.append(f"{where}：id {name} 已被占用")
        seen.add(name)
        if model.get("category") not in CATEGORIES:
            errors.append(f"{where}：category 须为 {'、'.join(CATEGORIES)} 之一")
        if model.get("palette") not in PALETTES:
            errors.append(f"{where}：palette 须为 {'、'.join(PALETTES)} 之一")
        if not model.get("name"):
            errors.append(f"{where}：缺少中文名 name")
        if not model.get("author"):
            errors.append(f"{where}：缺少作者 author（只收团队自制模型）")
        model.setdefault("scale", 1)
        model.setdefault("yaw", 0)
        model.setdefault("line", False)
        if not isinstance(model["scale"], int | float) or model["scale"] <= 0:
            errors.append(f"{where}：scale 须为正数")
        if model["yaw"] not in YAWS:
            errors.append(f"{where}：yaw 须为 0、90、180、270 之一")
        if not isinstance(model["line"], bool):
            errors.append(f"{where}：line 须为 true 或 false")
        source = directory / model.setdefault("file", f"{name}.glb")
        if source.suffix not in (".glb", ".gltf") or not source.is_file():
            errors.append(f"{where}：找不到模型文件 {model['file']}（.glb 或 .gltf）")
    if errors:
        sys.exit("自制模型清单有误：\n" + "\n".join(errors))
    return models


def build_custom(directory: Path, out: Path, work: Path, taken: set[str]) -> list[dict]:
    """自制模型合并为 out/scene-custom.glb，返回其目录条目；清单为空时不写文件。"""
    models = load_custom(directory, taken)
    if not models:
        return []
    staged = [stage(directory / m["file"], work, m["id"], m["palette"]) for m in models]
    sizes = merge(staged, out / CUSTOM_GLB)
    return [
        entry(m["id"], m["category"], m["name"], CUSTOM_GLB, sizes[m["id"]], m["scale"],
              m["yaw"], m["line"])
        for m in models
    ]  # fmt: skip


def write_catalog(catalog: list[dict], out: Path) -> None:
    categories = [{"id": c, "name": n} for c, n in CATEGORIES.items()]
    rows = ",\n  ".join(json.dumps(a, ensure_ascii=False) for a in catalog)
    head = json.dumps(categories, ensure_ascii=False)
    text = f'{{\n "categories": {head},\n "assets": [\n  {rows}\n ]\n}}\n'
    (out / "catalog.json").write_text(text, encoding="utf-8")


def registry(versions: dict[str, str], categories: list[str]) -> str:
    """deploy/third-party.yaml 的登记条目：每个类别文件一条，models 逐个列出来源模型。"""
    lines = []
    for category in categories:
        label = CATEGORIES[category]
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


def only(args: list[str], work: Path) -> list[dict]:
    """--only：重建模型全部来自给出的包的类别；其余类别与自制模型的目录条目、文件原样保留。"""
    sources = {}
    for arg in args:
        pack, _, path = arg.partition("=")
        if pack not in PACKS or not path:
            sys.exit(f"参数须为 <包名>=<压缩包或解压目录>，包名取 {', '.join(PACKS)}：{arg}")
        sources[pack] = Path(path).expanduser()
    categories = rebuildable(set(sources))
    if not categories:
        sys.exit("没有模型全部来自这些包的类别，无可重建")
    old = json.loads((OUT / "catalog.json").read_text(encoding="utf-8"))["assets"]
    for category in categories:
        (OUT / f"scene-{category}.glb").unlink(missing_ok=True)
    built = build(sources, work)
    kept = [a for a in old if a["category"] not in categories or a["file"] == CUSTOM_GLB]
    order = list(CATEGORIES)
    catalog = sorted(
        [a for a in kept if a["file"] != CUSTOM_GLB] + built,
        key=lambda a: order.index(a["category"]),
    )
    return catalog + [a for a in kept if a["file"] == CUSTOM_GLB]


def main() -> None:
    if len(sys.argv) < 2 or (sys.argv[1] != "--only" and len(sys.argv) != 2):
        sys.exit(__doc__)
    kenney = {s[0] for s in SELECTION}
    with tempfile.TemporaryDirectory() as tmp:
        if sys.argv[1] == "--only":
            write_catalog(only(sys.argv[2:], Path(tmp) / "kenney"), OUT)
            return
        if sys.argv[1] == "--custom":
            # 只重建自制模型：保留目录中 Kenney 的条目与类别文件，替换自制部分
            old = json.loads((OUT / "catalog.json").read_text(encoding="utf-8"))["assets"]
            catalog = [a for a in old if a["file"] != CUSTOM_GLB]
            (OUT / CUSTOM_GLB).unlink(missing_ok=True)
        else:
            for old_glb in OUT.glob("scene-*.glb"):
                old_glb.unlink()
            archives = Path(sys.argv[1])
            catalog = build({p: archives / f"{p}.zip" for p in PACKS}, Path(tmp) / "kenney")
        catalog += build_custom(CUSTOM_DIR, OUT, Path(tmp) / "custom", kenney)
    write_catalog(catalog, OUT)


if __name__ == "__main__":
    main()
