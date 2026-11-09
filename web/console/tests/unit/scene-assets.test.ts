import { type Matrix4, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { fadeTexture } from "../../src/scene/AreaScene";
import { type Asset, footprints, instances } from "../../src/scene/assets";

const asset = (id: string, footprint: [number, number], extra: Partial<Asset> = {}): Asset => ({
  id,
  category: "building",
  name: id,
  file: "scene-building.glb",
  footprint,
  scale: 8,
  yaw: 0,
  line: false,
  ...extra,
});
const CATALOG = new Map(
  [asset("office", [17, 11]), asset("wall", [2, 1], { category: "wall", scale: 1, yaw: 90, line: true })].map((a) => [a.id, a]),
);
const item = (asset: string, x: number, y: number, rot: 0 | 90 | 180 | 270 = 0, len: number | null = null) => ({ asset, x, y, rot, len });
/** 实例矩阵把模型局部点 p 放到的场景位置 */
const place = (m: Matrix4, p: [number, number, number]) => new Vector3(...p).applyMatrix4(m).toArray().map((v) => Math.round(v * 1000) / 1000 + 0);

describe("footprints：放置点约定（设计 150 §5）", () => {
  it("普通物体以 (x, y) 为占地中心，长宽取目录的占地格数", () => {
    expect(footprints([item("office", 20, 10, 90)], CATALOG)).toMatchObject([{ x: 20, y: 10, length: 17, width: 11, rot: 90 }]);
  });

  it("线状资产以 (x, y) 为起点沿放置方向按资产长度分段：0° 沿 +x，90° 沿 +y", () => {
    const east = footprints([item("wall", 0, 5, 0, 6)], CATALOG).map(({ x, y }) => [x, y]);
    expect(east).toEqual([[1, 5], [3, 5], [5, 5]]);
    const south = footprints([item("wall", 4, 0, 90, 4)], CATALOG).map(({ x, y }) => [Math.round(x * 1e9) / 1e9, y]);
    expect(south).toEqual([[4, 1], [4, 3]]);
  });

  it("线状资产长度不足一段时至少一段，未写长度时为一段", () => {
    expect(footprints([item("wall", 0, 0, 0, 1)], CATALOG)).toHaveLength(1);
    expect(footprints([item("wall", 0, 0, 0, null)], CATALOG)).toHaveLength(1);
  });

  it("目录中没有的资产跳过", () => {
    expect(footprints([item("missing", 0, 0)], CATALOG)).toEqual([]);
  });
});

describe("instances：同一资产的实例合为一组（V-P1）", () => {
  it("按资产分组；矩阵依次缩放、转 yaw 与放置方向，再平移到占地中心", () => {
    const groups = instances(footprints([item("office", 20, 10), item("office", 5, 5, 90), item("wall", 0, 0, 0, 4)], CATALOG));
    expect([...groups.keys()]).toEqual(["office", "wall"]);
    const [a, b] = groups.get("office") ?? [];
    if (!a || !b) throw new Error("缺少实例");
    // 缩放 8：模型局部 1 单位为 8 m
    expect(place(a, [1, 0, 0])).toEqual([28, 0, 10]);
    // 放置方向 90°：模型 +x 转向平面 +y（场景 +z），与摄像头朝向同一约定
    expect(place(b, [1, 0, 0])).toEqual([5, 0, 13]);
    // 墙的 yaw 90° 把模型长边（局部 z）转到 x：第一段中心在 (1, 0)，局部 +z 端点落在起点 (0, 0)
    const [wall] = groups.get("wall") ?? [];
    if (!wall) throw new Error("缺少墙");
    expect(place(wall, [0, 0, 0])).toEqual([1, 0, 0]);
    expect(place(wall, [0, 0, 1])).toEqual([0, 0, 0]);
  });
});

describe("fadeTexture：地面在区域外渐隐，看不到边（设计 150 §4）", () => {
  it("区域内不透明，区域外 15 m 处完全透明，其间单调下降", () => {
    const texture = fadeTexture(10, 10);
    const { data, width } = texture.image as { data: Uint8Array; width: number };
    const alpha = (i: number) => data[(Math.floor(width / 2) * width + i) * 4 + 1];
    expect(alpha(Math.floor(width / 2))).toBe(255); // 中心
    expect(alpha(0)).toBe(0); // 最外侧
    const row = Array.from({ length: Math.floor(width / 2) }, (_, i) => alpha(i) ?? 0);
    expect(row.every((v, i) => i === 0 || v >= (row[i - 1] ?? 0))).toBe(true);
  });
});
