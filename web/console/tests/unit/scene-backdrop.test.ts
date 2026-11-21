import { beforeEach, describe, expect, it, vi } from "vitest";
import { type Backdrop, backdropGeometry, toggleSceneMode, useSceneMode } from "../../src/scene/Backdrop";

/** 3 × 3 网格（2 × 2 个格子），只保留左上与右下两格：位图 1001 → 0b10010000 */
const backdrop: Backdrop = {
  cols: 3,
  rows: 3,
  points: Array.from({ length: 9 }, (_, k) => [k % 3, k === 4 ? 0.75 : 0, Math.floor(k / 3)]).flat(),
  quads: btoa(String.fromCharCode(0b10010000)),
  image: "",
};

describe("实景底图网格", () => {
  it("保留的格子各拆成两个三角形，位置取 (x, 高度, y)", () => {
    const geometry = backdropGeometry(backdrop);
    const index = Array.from(geometry.getIndex()?.array ?? []);
    // 左上格 (0,1,4,3) 与右下格 (4,5,8,7)，各两个三角形
    expect(index).toEqual([0, 3, 1, 1, 3, 4, 4, 7, 5, 5, 7, 8]);
    const position = geometry.getAttribute("position");
    expect([position.getX(4), position.getY(4), position.getZ(4)]).toEqual([1, 0.75, 1]);
  });

  it("贴图坐标为画面归一化坐标的格点中心，v 轴朝上", () => {
    const uv = backdropGeometry(backdrop).getAttribute("uv");
    const at = (k: number) => [uv.getX(k), uv.getY(k)].map((v) => Number(v.toFixed(4)));
    expect(at(0)).toEqual([0.1667, 0.8333]);
    expect(at(8)).toEqual([0.8333, 0.1667]);
  });
});

describe("实景与白模切换", () => {
  beforeEach(() => {
    localStorage.clear();
    useSceneMode.setState({ mode: "model" });
  });

  it("默认白模；切换为实景后记在本机", async () => {
    vi.resetModules();
    const fresh = await import("../../src/scene/Backdrop");
    expect(fresh.useSceneMode.getState().mode).toBe("model"); // 本机没有记录时
    toggleSceneMode();
    expect(useSceneMode.getState().mode).toBe("photo");
    expect(localStorage.getItem("hyd.scene-mode")).toBe("photo");
    toggleSceneMode();
    expect(useSceneMode.getState().mode).toBe("model");
  });
});
