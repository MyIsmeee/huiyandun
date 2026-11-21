"""人形零件（ui.md §5.1 L4）：在 Blender 中按 1.70 m 标准体型生成躯干、颈、上臂、前臂（含手）、大腿、小腿、脚、头，
导出 web/console/public/models/figure-parts.glb。前端把零件逐段摆到重建出的关节上（scene/parts.ts），不带骨骼与动画。

用法（需本机安装 Blender ≥ 4.2）：
  blender --background --python tools/dev/figure_parts.py
  blender --background --python tools/dev/figure_parts.py -- --blend <路径>   另存 .blend，供手工细修

零件约定（手工建模、细修后导出时同样遵守，见 web/console/assets/figure/README.md）：
- 每个零件一个物体，物体名即零件名（NAMES）；按米建模，全部变换已应用
- 原点在近端关节，沿 Blender +Z 伸向远端关节，两关节相距标准骨长（LENGTH，与 scene/parts.ts 一致）；
  躯干原点在髋中、向上到肩中；头的原点在头部中心
- Blender 的 X 为人体左右。躯干、四肢左右前后都对称：同一零件左右两侧共用，前端不区分正反面
- 脚的原点在脚踝正下方的脚底，+Z 指向脚尖，Blender −Y 为脚背一侧（导出后为 glTF +Z）
- 中性人偶（G-04）：没有面部、头发、服饰，不区分体型；颜色由前端按状态给出，零件不带材质与贴图
"""

import argparse
import math
import sys
from pathlib import Path

import bmesh
import bpy

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "web/console/public/models/figure-parts.glb"
NAMES = ("torso", "neck", "upper_arm", "forearm", "thigh", "shin", "foot", "head")
# 标准骨长（米）：近端关节到远端关节，与 scene/body.ts 的 L、scene/parts.ts 的 PARTS 一致
LENGTH = {
    "torso": 0.5,
    "neck": 0.22,
    "upper_arm": 0.3,
    "forearm": 0.26,
    "thigh": 0.42,
    "shin": 0.42,
    "foot": 0.19,
}
ROUND = 16  # 回转体每圈的顶点数
OVAL = 24  # 躯干、脚每圈的顶点数
CAP = 4  # 端部半球的圈数

type Point = tuple[float, float, float]  # 零件坐标：x 左右、y 沿骨段（近端 → 远端）、z 前后
type Ring = list[Point]


def smooth(points: list[tuple[float, ...]], steps: int = 4) -> list[tuple[float, ...]]:
    """过各控制点的 Catmull-Rom 曲线，每段取 steps 个点；首尾控制点各出现一次。"""
    out: list[tuple[float, ...]] = []
    for i in range(len(points) - 1):
        p0, p1, p2, p3 = (points[min(max(j, 0), len(points) - 1)] for j in range(i - 1, i + 3))
        for s in range(steps):
            t = s / steps
            out.append(
                tuple(
                    0.5
                    * (
                        2 * b
                        + (c - a) * t
                        + (2 * a - 5 * b + 4 * c - d) * t * t
                        + (3 * b - a - 3 * c + d) * t**3
                    )
                    for a, b, c, d in zip(p0, p1, p2, p3, strict=True)
                )
            )
    return [*out, points[-1]]


def circle(y: float, r: float) -> Ring:
    return [
        (r * math.cos(2 * math.pi * i / ROUND), y, r * math.sin(2 * math.pi * i / ROUND))
        for i in range(ROUND)
    ]


def lathe(profile: list[tuple[float, float]]) -> tuple[Point, list[Ring], Point]:
    """回转体：profile 为沿骨段的（位置, 半径）控制点；两端各接一个半球，球心在首末控制点处（即关节处）。"""
    (y0, r0), (y1, r1) = profile[0], profile[-1]
    angles = [math.pi / 2 * k / CAP for k in range(1, CAP)]
    start = [circle(y0 - r0 * math.cos(a), r0 * math.sin(a)) for a in angles]
    end = [circle(y1 + r1 * math.cos(a), r1 * math.sin(a)) for a in reversed(angles)]
    body = [circle(y, r) for y, r in smooth(profile)]
    return (0, y0 - r0, 0), [*start, *body, *end], (0, y1 + r1, 0)


def oval(
    y: float, a: float, b: float, power: float = 2.6, lift: float = 0.0, low: float | None = None
) -> Ring:
    """超椭圆截面：半宽 a（左右）、半厚 b（前后），power 越大越方；lift 为截面中心的前后偏移，
    low 为后半圈（z 小于中心的一侧）另用的 power。"""
    ring = []
    for i in range(OVAL):
        t = 2 * math.pi * i / OVAL
        c, s = math.cos(t), math.sin(t)
        n = low if low is not None and s < 0 else power
        ring.append(
            (
                a * math.copysign(abs(c) ** (2 / n), c),
                y,
                lift + b * math.copysign(abs(s) ** (2 / n), s),
            )
        )
    return ring


def build(name: str, shells: list[tuple[Point, list[Ring], Point]]) -> bpy.types.Object:
    """各壳体（起点、各圈、终点）蒙成封闭曲面，合为一个物体；面朝外、平滑着色。"""
    mesh = bpy.data.meshes.new(name)
    bm = bmesh.new()
    for first, rings, last in shells:
        # 零件坐标 (x, y, z) → Blender (x, −z, y)：导出 +Y Up 后还原为 (x, y, z)
        vert = lambda p: bm.verts.new((p[0], -p[2], p[1]))  # noqa: E731
        loops = [[vert(p) for p in ring] for ring in rings]
        n = len(loops[0])
        for a, b in zip(loops, loops[1:], strict=False):
            for i in range(n):
                bm.faces.new((a[i], a[(i + 1) % n], b[(i + 1) % n], b[i]))
        for pole, loop in ((vert(first), loops[0]), (vert(last), loops[-1])):
            for i in range(n):
                bm.faces.new((pole, loop[i], loop[(i + 1) % n]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    for face in bm.faces:
        face.smooth = True
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def torso() -> list[tuple[Point, list[Ring], Point]]:
    # （高度, 半宽, 半厚）：髋中为 0、肩中为 0.5；肩关节在 ±0.19、髋关节在 ±0.10（scene/body.ts）
    sections = [
        (-0.07, 0.085, 0.065),
        (-0.03, 0.14, 0.092),
        (0.03, 0.156, 0.1),
        (0.12, 0.142, 0.093),
        (0.2, 0.126, 0.085),
        (0.3, 0.14, 0.095),
        (0.4, 0.16, 0.105),
        (0.47, 0.168, 0.1),
        (0.52, 0.15, 0.085),
        (0.555, 0.085, 0.065),
    ]
    rings = [oval(y, a, b) for y, a, b in smooth(sections, 3)]
    return [((0, -0.09, 0), rings, (0, 0.575, 0))]


def foot() -> list[tuple[Point, list[Ring], Point]]:
    # （沿脚长的位置, 半宽, 高）：脚踝在 0、脚尖在 0.19，脚跟在脚踝后方；脚底为 z = 0 的平面
    sections = [
        (-0.062, 0.026, 0.05),
        (-0.04, 0.038, 0.078),
        (0.0, 0.043, 0.09),
        (0.05, 0.045, 0.078),
        (0.11, 0.047, 0.056),
        (0.16, 0.042, 0.042),
        (0.186, 0.026, 0.03),
    ]
    # 上半圈圆（脚背），下半圈接近方形（平的脚底）
    rings = [oval(y, w, h / 2, power=2.4, lift=h / 2, low=7.0) for y, w, h in smooth(sections, 3)]
    return [((0, -0.07, 0.025), rings, (0, 0.195, 0.015))]


def head() -> tuple[Point, list[Ring], Point]:
    """卵形：上圆下收，没有面部；原点在头部中心。"""
    top, bottom, radius = 0.118, 0.128, 0.098
    rings = []
    steps = 14
    for k in range(1, steps):
        t = -1 + 2 * k / steps  # −1 为下巴、1 为头顶
        y = t * (top if t > 0 else bottom)
        r = radius * math.sqrt(1 - t * t) * (1 - 0.16 * max(0.0, -t) ** 1.5)
        rings.append(circle(y, r))
    return (0, -bottom, 0), rings, (0, top, 0)


def parts() -> dict[str, list[tuple[Point, list[Ring], Point]]]:
    # 手：不分手指的椭球，自腕关节略靠内处伸出
    half, radius = 0.062, 0.036  # 沿前臂的半长、半径
    center = LENGTH["forearm"] - 0.02 + half
    mitten = [
        circle(center + half * math.sin(a), radius * math.cos(a))
        for a in (math.pi * (k / 10 - 0.5) for k in range(1, 10))
    ]
    return {
        "torso": torso(),
        "neck": [lathe([(0.0, 0.056), (0.1, 0.05), (LENGTH["neck"], 0.046)])],
        "upper_arm": [
            lathe([(0.0, 0.052), (0.1, 0.05), (0.2, 0.045), (LENGTH["upper_arm"], 0.04)])
        ],
        "forearm": [
            lathe([(0.0, 0.04), (0.07, 0.042), (0.17, 0.035), (LENGTH["forearm"], 0.029)]),
            ((0, center - half, 0), mitten, (0, center + half, 0)),
        ],
        "thigh": [lathe([(0.0, 0.078), (0.14, 0.075), (0.3, 0.064), (LENGTH["thigh"], 0.055)])],
        "shin": [lathe([(0.0, 0.054), (0.11, 0.058), (0.26, 0.047), (LENGTH["shin"], 0.038)])],
        "foot": foot(),
        "head": [head()],
    }


def main() -> None:
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser(description="生成人形零件并导出 glb")
    parser.add_argument("--blend", type=Path, help="另存 .blend，供手工细修")
    args = parser.parse_args(argv)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    built = parts()
    assert tuple(built) == NAMES
    for name, shells in built.items():
        build(name, shells)
    if args.blend:
        bpy.ops.wm.save_as_mainfile(filepath=str(args.blend.resolve()))
    OUT.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=str(OUT),
        export_format="GLB",
        export_yup=True,
        export_apply=True,
        export_normals=True,
        export_texcoords=False,
        export_materials="NONE",
        export_animations=False,
        export_skins=False,
        export_cameras=False,
        export_lights=False,
    )
    triangles = sum(len(p.vertices) - 2 for o in bpy.data.objects for p in o.data.polygons)
    print(
        f"figure-parts: {len(built)} 个零件，{triangles} 个三角面，{OUT.stat().st_size} 字节 → {OUT}"
    )


main()
