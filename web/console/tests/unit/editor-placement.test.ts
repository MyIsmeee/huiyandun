import { describe, expect, it } from "vitest";
import { extent, inside, overlaps, rotated, snap, stroke } from "../../src/editor/placement";
import type { Asset } from "../../src/scene/assets";

const asset = (id: string, category: string, footprint: [number, number], line = false): Asset => ({
  id,
  category,
  name: id,
  file: `scene-${category}.glb`,
  footprint,
  scale: 1,
  yaw: 0,
  line,
});
const DESK = asset("desk", "furniture", [2, 1]);
const TREE = asset("tree", "greenery", [2, 2]);
const GRASS = asset("grass", "greenery", [2, 2]);
const PLAZA = asset("plaza", "road", [2, 2]);
const WALL = asset("wall", "wall", [2, 1], true);
const CATALOG = new Map([DESK, TREE, GRASS, PLAZA, WALL].map((a) => [a.id, a]));
const item = (id: string, x: number, y: number, len: number | null = null) => ({ asset: id, x, y, rot: 0 as const, len });

describe("snap：放置点吸附 1 m 网格（设计 150 E-2）", () => {
  it("占地边缘落在网格上：偶数边长的中心在整米，奇数边长的中心在半米", () => {
    expect(snap(DESK, 0, [10.3, 10.4], [40, 24])).toEqual(item("desk", 10, 10.5));
    expect(snap(TREE, 0, [5.6, 5.4], [40, 24])).toEqual(item("tree", 6, 5));
  });

  it("整块留在区域内：靠近边缘时向内收", () => {
    expect(snap(DESK, 0, [0.2, 23.9], [40, 24])).toEqual(item("desk", 1, 23.5));
    expect(snap(TREE, 0, [40, -3], [40, 24])).toEqual(item("tree", 39, 1));
  });

  it("旋转 90° 时长宽互换", () => {
    expect(snap(DESK, 90, [10.3, 10.4], [40, 24])).toMatchObject({ x: 10.5, y: 10, rot: 90 });
  });

  it("线状资产先放一段：放置点为起点，长度为一段资产长度（设计 150 §5）", () => {
    expect(snap(WALL, 0, [10.3, 10.4], [40, 24])).toEqual(item("wall", 9, 10.5, 2));
    expect(snap(WALL, 90, [10.3, 10.4], [40, 24])).toEqual({ asset: "wall", x: 10.5, y: 9, rot: 90, len: 2 });
  });
});

describe("overlaps：与同一层已有物体重叠时禁止放置（设计 150 E-2）", () => {
  it("占地相交为重叠，只接触边缘不算", () => {
    const placed = [item("desk", 10, 10.5)];
    expect(overlaps(item("desk", 11, 10.5), placed, CATALOG)).toBe(true);
    expect(overlaps(item("desk", 12, 10.5), placed, CATALOG)).toBe(false);
    expect(overlaps(item("desk", 10, 11.5), placed, CATALOG)).toBe(false);
  });

  it("地面层（广场、草地）与其上的物体互不占位，地面层之间、物体之间才算重叠", () => {
    expect(overlaps(item("tree", 5, 5), [item("grass", 5, 5)], CATALOG)).toBe(false);
    expect(overlaps(item("desk", 5, 5.5), [item("plaza", 5, 5)], CATALOG)).toBe(false);
    expect(overlaps(item("plaza", 5, 5), [item("grass", 5, 5)], CATALOG)).toBe(true);
  });

  it("线状资产按分段后的每一段判断", () => {
    const wall = [item("wall", 0, 5.5, 6)];
    expect(overlaps(item("desk", 5, 5.5), wall, CATALOG)).toBe(true);
    expect(overlaps(item("desk", 7, 5.5), wall, CATALOG)).toBe(false);
  });
});

describe("rotated：旋转 90°（设计 150 E-4）", () => {
  it("普通物体绕占地中心转，长宽奇偶不同时中心挪半格吸附网格", () => {
    expect(rotated(item("desk", 10, 10.5), DESK, CATALOG, [40, 24])).toEqual({ ...item("desk", 10.5, 11), rot: 90 });
  });

  it("线状资产绕起点转；转后超出区域时不转", () => {
    expect(rotated(item("wall", 4, 5.5, 4), WALL, CATALOG, [40, 24])).toEqual({ ...item("wall", 4, 5.5, 4), rot: 90 });
    expect(rotated(item("wall", 4, 22.5, 4), WALL, CATALOG, [40, 24])).toBeNull();
  });

  it("inside：线状资产逐段判断是否在区域内", () => {
    expect(inside(item("wall", 36, 5.5, 4), CATALOG, [40, 24])).toBe(true);
    expect(inside(item("wall", 37, 5.5, 4), CATALOG, [40, 24])).toBe(false);
  });
});

describe("stroke：线状资产按下拖动画线（设计 150 E-3）", () => {
  it("沿位移较大的坐标轴铺设，长度取资产长度的整数倍；起点为按下处的网格交点，奇数宽时中线让开半格", () => {
    expect(stroke(WALL, [5.2, 4.9], [12.3, 5.4])).toEqual({ asset: "wall", x: 5, y: 5.5, rot: 0, len: 8 });
    expect(stroke(WALL, [20, 3], [20.4, 9.6])).toEqual({ asset: "wall", x: 20.5, y: 3, rot: 90, len: 6 });
    expect(stroke(WALL, [10, 10], [4.4, 10.3])).toMatchObject({ x: 10, rot: 180, len: 6 });
  });

  it("没怎么拖动时为一段", () => {
    expect(stroke(WALL, [5, 5], [5.3, 5.1])).toMatchObject({ rot: 0, len: 2 });
  });

  it("extent：合并各段的外接矩形", () => {
    expect(extent(stroke(WALL, [5, 5], [11, 5]), CATALOG)).toEqual([5, 5, 11, 6]);
  });
});
