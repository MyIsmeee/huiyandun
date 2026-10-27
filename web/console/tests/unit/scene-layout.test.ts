import { describe, expect, it } from "vitest";
import type { Site } from "../../src/lib/api";
import { isEmpty, isoView, OVERVIEW, planView, WALL_HEIGHT_M, zoneAnchor, zoneLabel } from "../../src/scene/layout";

const SITE: Site = { id: "s", name: "站点", width_m: 40, height_m: 24, walls: [], doors: [], zones: [], devices: [] };
const SIZE = { width: 1100, height: 700 };
// 与 layout.ts 的 INSET 一致：顶部留出 KPI 底板，底部留出断线提示
const AREA = { left: 24, top: 112, right: SIZE.width - 24, bottom: SIZE.height - 56 };

function bounds(points: (readonly [number, number])[]) {
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  return { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) };
}

describe("isoView", () => {
  const view = isoView(SITE, SIZE);
  const corners = [0, WALL_HEIGHT_M].flatMap((y) =>
    [
      [0, 0],
      [40, 0],
      [40, 24],
      [0, 24],
    ].map(([x = 0, z = 0]) => view.project([x, y, z])),
  );

  it("站点包围盒落在可用区域内，并在一个方向上贴满", () => {
    const box = bounds(corners);
    expect(box.left).toBeGreaterThanOrEqual(AREA.left - 1e-6);
    expect(box.right).toBeLessThanOrEqual(AREA.right + 1e-6);
    expect(box.top).toBeGreaterThanOrEqual(AREA.top - 1e-6);
    expect(box.bottom).toBeLessThanOrEqual(AREA.bottom + 1e-6);
    const fills = [box.left - AREA.left, AREA.right - box.right, box.top - AREA.top, AREA.bottom - box.bottom];
    expect(fills.filter((gap) => Math.abs(gap) < 1e-6).length).toBe(2);
  });

  it("在可用区域内居中", () => {
    const box = bounds(corners);
    expect(box.left - AREA.left).toBeCloseTo(AREA.right - box.right);
    expect(box.top - AREA.top).toBeCloseTo(AREA.bottom - box.bottom);
  });

  it("原点在最远处（画面上方），x 向右下、y 向左下", () => {
    const [origin, east, south] = [view.project([0, 0, 0]), view.project([1, 0, 0]), view.project([0, 0, 1])];
    expect(origin[1]).toBeLessThan(east[1]);
    expect(east[0]).toBeGreaterThan(origin[0]);
    expect(south[0]).toBeLessThan(origin[0]);
    expect(south[1]).toBeGreaterThan(origin[1]);
  });

  it("大站点的包围盒也完整落在相机可见深度内", () => {
    const big = { ...SITE, width_m: 1000, height_m: 800 };
    const v = isoView(big, SIZE);
    const back = v.position.map((p, i) => p - (v.target[i] ?? 0));
    const length = Math.hypot(...back);
    const depth = ([x, y, z]: number[]) =>
      ((v.position[0] - (x ?? 0)) * (back[0] ?? 0) +
        (v.position[1] - (y ?? 0)) * (back[1] ?? 0) +
        (v.position[2] - (z ?? 0)) * (back[2] ?? 0)) /
      length;
    for (const x of [0, 1000])
      for (const y of [0, WALL_HEIGHT_M])
        for (const z of [0, 800]) {
          expect(depth([x, y, z])).toBeGreaterThan(v.near);
          expect(depth([x, y, z])).toBeLessThan(v.far);
        }
  });

  it("相机沿等距方向看向目标点", () => {
    const d = view.position.map((p, i) => p - (view.target[i] ?? 0));
    expect(d[0]).toBeCloseTo(d[1] ?? 0);
    expect(d[1]).toBeCloseTo(d[2] ?? 0);
    expect(d[0]).toBeGreaterThan(0);
  });
});

describe("planView", () => {
  it("等比缩放，站点完整落在可用区域内并居中", () => {
    const view = planView(SITE, SIZE);
    const box = bounds([view.project([0, 0, 0]), view.project([40, 0, 24])]);

    expect((box.right - box.left) / (box.bottom - box.top)).toBeCloseTo(40 / 24);
    expect(box.left - AREA.left).toBeCloseTo(AREA.right - box.right);
    expect(box.top - AREA.top).toBeCloseTo(AREA.bottom - box.bottom);
    expect(Math.min(box.left - AREA.left, box.top - AREA.top)).toBeCloseTo(0);
  });
});

describe("区域标注", () => {
  it("位于顶点均值处", () => {
    expect(
      zoneAnchor([
        [30, 0],
        [40, 0],
        [40, 6],
        [30, 6],
      ]),
    ).toEqual([35, 0, 3]);
  });

  it("禁止攀爬区在名称后注明", () => {
    const zone = { id: "z", name: "外墙", polygon: [], no_climb: true };
    expect(zoneLabel(zone)).toBe("外墙 · 禁止攀爬");
    expect(zoneLabel({ ...zone, no_climb: false })).toBe("外墙");
  });
});

it("没有墙体与区域为空场景", () => {
  expect(isEmpty(SITE)).toBe(true);
  expect(isEmpty({ ...SITE, walls: [[0, 0, 1, 0]] })).toBe(false);
});

// V-I1：绕竖轴旋转 4 档、缩放 1～4 倍、放大后平移
describe("相机姿态", () => {
  const QUARTERS = [0, 1, 2, 3].map((k) => (k * Math.PI) / 2);
  const box = (view: ReturnType<typeof isoView> | ReturnType<typeof planView>, heights: number[]) =>
    bounds(
      heights.flatMap((y) =>
        [
          [0, 0],
          [40, 0],
          [40, 24],
          [0, 24],
        ].map(([x = 0, z = 0]) => view.project([x, y, z])),
      ),
    );
  const angle = (view: ReturnType<typeof isoView>, [x, y]: readonly [number, number]) => {
    const [cx, cy] = view.project([20, 0, 12]);
    const [px, py] = view.project([x, 0, y]);
    return Math.atan2(py - cy, px - cx); // 画面 y 向下，角度增大为顺时针
  };

  it.each(QUARTERS)("方位角 %f：等距视图与 2D 平面图都完整落在可用区域内并居中", (azimuth) => {
    const pose = { ...OVERVIEW, azimuth };
    for (const b of [box(isoView(SITE, SIZE, pose), [0, WALL_HEIGHT_M]), box(planView(SITE, SIZE, pose), [0])]) {
      expect(b.left).toBeGreaterThanOrEqual(AREA.left - 1e-6);
      expect(b.right).toBeLessThanOrEqual(AREA.right + 1e-6);
      expect(b.top).toBeGreaterThanOrEqual(AREA.top - 1e-6);
      expect(b.bottom).toBeLessThanOrEqual(AREA.bottom + 1e-6);
      expect(b.left - AREA.left).toBeCloseTo(AREA.right - b.right);
      expect(b.top - AREA.top).toBeCloseTo(AREA.bottom - b.bottom);
    }
  });

  it("方位角增大一档，场景在画面上顺时针转 90°", () => {
    const before = angle(isoView(SITE, SIZE), [30, 12]);
    const after = angle(isoView(SITE, SIZE, { ...OVERVIEW, azimuth: Math.PI / 2 }), [30, 12]);
    const delta = (after - before + 2 * Math.PI) % (2 * Math.PI);
    expect(delta).toBeGreaterThan(0);
    expect(delta).toBeLessThan(Math.PI);

    const [x, y] = planView(SITE, SIZE, { ...OVERVIEW, azimuth: Math.PI / 2 }).project([30, 0, 12]);
    const [cx, cy] = planView(SITE, SIZE, { ...OVERVIEW, azimuth: Math.PI / 2 }).project([20, 0, 12]);
    expect(x).toBeCloseTo(cx); // 东侧的点转到正下方
    expect(y).toBeGreaterThan(cy);
  });

  it("相机朝向随方位角转动：默认在东南，转一档到东北", () => {
    const [a, b] = [isoView(SITE, SIZE).toCamera, isoView(SITE, SIZE, { ...OVERVIEW, azimuth: Math.PI / 2 }).toCamera];
    expect(a[0]).toBeCloseTo(Math.SQRT1_2);
    expect(a[1]).toBeCloseTo(Math.SQRT1_2);
    expect(b[0]).toBeCloseTo(Math.SQRT1_2);
    expect(b[1]).toBeCloseTo(-Math.SQRT1_2);
  });

  it("放大 2 倍：每米像素数加倍；2D 平面图以可用区域中心为锚点", () => {
    for (const make of [isoView, planView]) {
      expect(make(SITE, SIZE, { ...OVERVIEW, zoom: 2 }).zoom).toBeCloseTo(2 * make(SITE, SIZE).zoom);
    }
    const center = planView(SITE, SIZE, { ...OVERVIEW, zoom: 2 }).project([20, 0, 12]);
    expect(center[0]).toBeCloseTo((AREA.left + AREA.right) / 2);
    expect(center[1]).toBeCloseTo((AREA.top + AREA.bottom) / 2);
  });

  it("平移 1 米：画面内容反向移动 zoom 个像素", () => {
    for (const make of [isoView, planView]) {
      const pose = { ...OVERVIEW, zoom: 2 };
      const [x0, y0] = make(SITE, SIZE, pose).project([20, 0, 12]);
      const [x1, y1] = make(SITE, SIZE, { ...pose, pan: [1, 1] }).project([20, 0, 12]);
      const zoom = make(SITE, SIZE, pose).zoom;
      expect(x1 - x0).toBeCloseTo(-zoom);
      expect(y1 - y0).toBeCloseTo(-zoom);
    }
  });

  it("平移上限为站点投影尺寸的一半", () => {
    const view = planView(SITE, SIZE);
    expect(view.panLimit).toEqual([20, 12]);
    expect(planView(SITE, SIZE, { ...OVERVIEW, azimuth: Math.PI / 2 }).panLimit.map((v) => Math.round(v))).toEqual([
      12, 20,
    ]);
  });
});
