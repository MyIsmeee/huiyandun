import { describe, expect, it } from "vitest";
import { pageCount, pageItems, pageOf, tileSize, wallGrid } from "../../src/panels/VideoWall/grid";

const cams = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `cam-${String(i + 1).padStart(2, "0")}` }));
const ids = (items: ({ id: string } | null)[]) => items.map((i) => i?.id ?? null);

describe("wallGrid（V-W1）", () => {
  it.each([
    [1, 1, 1],
    [2, 2, 1],
    [3, 2, 2],
    [4, 2, 2],
    [5, 3, 2],
    [9, 3, 3],
    [10, 4, 3],
    [16, 4, 4],
    [40, 4, 4],
  ])("自动：%i 路为 %i 列 %i 行，最多 4×4", (n, cols, rows) => {
    const grid = wallGrid(n, "auto");
    expect([grid.cols, grid.rows]).toEqual([cols, rows]);
    expect(grid.fixed).toBe(false);
  });

  it("没有摄像头时按 1 路计，不出现 0 列", () => {
    expect(wallGrid(0, "auto")).toMatchObject({ cols: 1, rows: 1, capacity: 1 });
  });

  it("固定布局与 1+5 的容量", () => {
    expect(wallGrid(2, "4").capacity).toBe(4);
    expect(wallGrid(2, "9").capacity).toBe(9);
    expect(wallGrid(2, "1+5")).toMatchObject({ cols: 3, rows: 3, capacity: 6, featured: true });
  });
});

describe("分页与空位", () => {
  it("自动布局不补空位，固定布局不足一页补空位", () => {
    expect(ids(pageItems(cams(3), wallGrid(3, "auto"), 0, null))).toEqual(["cam-01", "cam-02", "cam-03"]);
    expect(ids(pageItems(cams(2), wallGrid(2, "4"), 0, null))).toEqual(["cam-01", "cam-02", null, null]);
  });

  it("超出容量分页，最后一页按布局补空位", () => {
    const grid = wallGrid(5, "4");
    expect(pageCount(5, grid)).toBe(2);
    expect(ids(pageItems(cams(5), grid, 1, null))).toEqual(["cam-05", null, null, null]);
    expect(pageCount(17, wallGrid(17, "auto"))).toBe(2);
  });

  it("1+5：选中的摄像头放在大格，其余保持登记顺序", () => {
    const grid = wallGrid(4, "1+5");
    expect(ids(pageItems(cams(4), grid, 0, "cam-03"))).toEqual(["cam-03", "cam-01", "cam-02", "cam-04", null, null]);
    expect(ids(pageItems(cams(4), grid, 0, null))).toEqual(["cam-01", "cam-02", "cam-03", "cam-04", null, null]);
  });

  it("非 1+5 布局选中不改变顺序（V-L1 位置记忆）", () => {
    expect(ids(pageItems(cams(4), wallGrid(4, "4"), 0, "cam-03"))).toEqual(["cam-01", "cam-02", "cam-03", "cam-04"]);
  });

  it("pageOf 找到摄像头所在页，找不到返回 null", () => {
    const grid = wallGrid(10, "4");
    expect(pageOf(cams(10), grid, "cam-06", null)).toBe(1);
    expect(pageOf(cams(10), grid, "cam-99", null)).toBeNull();
  });
});

describe("tileSize", () => {
  it("每格保持 16:9，取宽高两个方向中较小的一个", () => {
    // 宽：(1000 - 8×3)/2 = 488；高：(600 - 8×3)/2 × 16/9 = 512 → 取 488
    expect(tileSize(1000, 600, wallGrid(4, "4"), 8)).toEqual({ w: 488, h: 274 });
    // 很矮的画布由高度决定：(300 - 16) × 16/9 = 504.8
    expect(tileSize(1000, 300, wallGrid(1, "1"), 8)).toEqual({ w: 504, h: 283 });
  });

  it("画布过小时不出现负数", () => {
    expect(tileSize(4, 4, wallGrid(9, "9"), 8)).toEqual({ w: 0, h: 0 });
  });
});
