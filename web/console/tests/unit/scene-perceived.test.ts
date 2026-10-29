import { Box3, type BufferAttribute, type BufferGeometry, Color } from "three";
import { describe, expect, it } from "vitest";
import type { Camera } from "../../src/scene/devices";
import { area, isStale, largestFirst, PALETTE, sceneGeometry, visibleScenes } from "../../src/scene/perceived";
import type { SceneFrame } from "../../src/store/live";

const NOW = Date.parse("2026-10-27T06:30:00Z");
const EMPTY = { surfaces: [], walls: [], objects: [], trees: [], markings: [] };
// 生成的类型把 $defs 列为必填（JSON Schema 的定义区，推送中没有），以断言构造
const frame = (camera_id: string, more: Partial<SceneFrame> = {}) =>
  ({
    schema_version: "1.0.0",
    event_id: "00000000-0000-4000-8000-000000000000",
    ts: "2026-10-27T06:30:00Z",
    camera_id,
    ...EMPTY,
    ...more,
  }) as SceneFrame;
const camera = (id: string, calibrated: boolean): Camera => ({
  id,
  state: calibrated ? "normal" : "uncalibrated",
  calibrated,
  severe: false,
  pose: { x: 0, y: 0, height_m: 3, yaw_deg: 0, pitch_deg: -30, hfov_deg: 90, range_m: 15 },
});
const square = (x: number, y: number, size: number) => [
  [x, y],
  [x + size, y],
  [x + size, y + size],
  [x, y + size],
];
const bounds = (geometry: BufferGeometry | null) => {
  expect(geometry).not.toBeNull();
  return new Box3().setFromBufferAttribute(geometry?.getAttribute("position") as BufferAttribute);
};

describe("陈旧（设计 §3.7）", () => {
  it("场景帧自带的 ts 早于 10 s 前即为陈旧", () => {
    expect(isStale(frame("cam-01", { ts: "2026-10-27T06:29:51Z" }), NOW)).toBe(false);
    expect(isStale(frame("cam-01", { ts: "2026-10-27T06:29:49.999Z" }), NOW)).toBe(true);
  });
});

it("只渲染已标定、已登记摄像头的场景（V-U2）", () => {
  const scenes = { "cam-01": frame("cam-01"), "cam-02": frame("cam-02"), "cam-09": frame("cam-09") };
  const cameras = [camera("cam-01", true), camera("cam-02", false)];

  expect(visibleScenes(scenes, cameras).map((s) => s.camera_id)).toEqual(["cam-01"]);
});

describe("地面色块（设计 §3.3）", () => {
  it("面积与顶点绕向无关", () => {
    expect(area(square(0, 0, 2))).toBe(4);
    expect(area(square(0, 0, 2).reverse())).toBe(4);
  });

  it("按面积从大到小绘制：被包住的小块在后，盖在上面", () => {
    const road = { class: "road" as const, polygon: square(0, 0, 10) };
    const island = { class: "grass" as const, polygon: square(4, 4, 2) };

    expect(largestFirst([island, road])).toEqual([road, island]);
  });

  it("合并后的首个顶点取最大色块的类别色，且落在地面", () => {
    const surfaces = [
      { class: "grass" as const, polygon: square(4, 4, 2) },
      { class: "road" as const, polygon: square(0, 0, 10) },
    ];
    const { flat, solid } = sceneGeometry(frame("cam-01", { surfaces }), PALETTE.light);
    const color = flat?.getAttribute("color") as BufferAttribute;

    expect(solid).toBeNull();
    expect(new Color(color.getX(0), color.getY(0), color.getZ(0)).getHexString()).toBe(
      new Color(PALETTE.light.road).getHexString(),
    );
    const box = bounds(flat);
    expect(box.min.y).toBeCloseTo(box.max.y);
    expect(box.max.y).toBeCloseTo(0.05); // 与栅格（0.005 m）相距 5 cm，不争深度
    expect([box.min.x, box.min.z, box.max.x, box.max.z]).toEqual([0, 0, 10, 10]); // 平面 (x, y) → 场景 (x, z)
  });
});

describe("立面、物体与树（§5.1 L1）", () => {
  it("立面沿墙脚线挤出到给定高度，物体由底面轮廓挤出", () => {
    const walls = [{ class: "building" as const, line: [[0, 5], [10, 5]], height_m: 6 }];
    const objects = [{ class: "furniture" as const, polygon: square(2, 2, 1), height_m: 0.8 }];

    const wall = bounds(sceneGeometry(frame("cam-01", { walls }), PALETTE.light).solid);
    const object = bounds(sceneGeometry(frame("cam-01", { objects }), PALETTE.light).solid);

    const close = (actual: number[], expected: number[]) => actual.forEach((v, i) => expect(v).toBeCloseTo(expected[i] ?? NaN));
    close([wall.min.y, wall.max.y, wall.min.x, wall.max.x, wall.min.z, wall.max.z], [0, 6, 0, 10, 4.9, 5.1]);
    close([object.min.y, object.max.y, object.min.x, object.min.z, object.max.x, object.max.z], [0, 0.8, 2, 2, 3, 3]);
  });

  it("树立在底部中心，树冠顶即树高", () => {
    const tree = bounds(sceneGeometry(frame("cam-01", { trees: [{ x: 3, y: 4, height_m: 5 }] }), PALETTE.light).solid);

    expect(tree.min.y).toBeCloseTo(0);
    expect(tree.max.y).toBeCloseTo(5, 1);
    expect((tree.min.x + tree.max.x) / 2).toBeCloseTo(3);
    expect((tree.min.z + tree.max.z) / 2).toBeCloseTo(4);
  });

  it("标线绘制在地面色块之上", () => {
    const surfaces = [{ class: "road" as const, polygon: square(0, 0, 10) }];
    const markings = [{ class: "lane" as const, polygon: square(4, 0, 0.2) }];
    const { flat } = sceneGeometry(frame("cam-01", { surfaces, markings }), PALETTE.light);
    const position = flat?.getAttribute("position");
    const last = position ? position.getY(position.count - 1) : 0;

    expect(last).toBeGreaterThan(position?.getY(0) ?? 0);
  });

  it("没有识别结果时不生成几何体", () => {
    expect(sceneGeometry(frame("cam-01"), PALETTE.dark)).toEqual({ flat: null, solid: null });
  });
});
