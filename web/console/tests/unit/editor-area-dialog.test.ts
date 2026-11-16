import { describe, expect, it } from "vitest";
import { outsideAfterResize } from "../../src/editor/AreaDialogs";
import type { Asset } from "../../src/scene/assets";

const DESK: Asset = { id: "desk", category: "furniture", name: "desk", file: "scene-furniture.glb", footprint: [2, 1], scale: 1, yaw: 0, line: false };
const CATALOG = new Map([[DESK.id, DESK]]);
const desk = (x: number, y: number) => ({ asset: "desk", x, y, rot: 0 as const, len: null });
const camera = (id: string, x: number, y: number) => ({ id, x, y, yaw_deg: 0 });

describe("编辑区域：缩小后放不下的物体与摄像头", () => {
  it("放大或尺寸不变时没有超出的", () => {
    expect(outsideAfterResize([desk(10, 10.5)], [camera("cam-01", 20, 12)], CATALOG, [40, 24])).toEqual({ items: 0, cameras: [] });
    expect(outsideAfterResize([desk(10, 10.5)], [camera("cam-01", 20, 12)], CATALOG, [80, 50])).toEqual({ items: 0, cameras: [] });
  });

  it("物体按占地判断：放置点在区域内、占地伸出边界同样算超出", () => {
    // 桌子中心 x=10、宽 2 m：占地到 x=11，区域宽 10.5 时放置点在内而占地伸出
    expect(outsideAfterResize([desk(10, 10.5)], [], CATALOG, [10.5, 24]).items).toBe(1);
    expect(outsideAfterResize([desk(10, 10.5)], [], CATALOG, [11, 24]).items).toBe(0);
  });

  it("摄像头按放置点判断，与服务端一致，并列出编号", () => {
    expect(outsideAfterResize([], [camera("cam-01", 20, 12), camera("cam-02", 5, 5)], CATALOG, [15, 24])).toEqual({ items: 0, cameras: ["cam-01"] });
  });
});
