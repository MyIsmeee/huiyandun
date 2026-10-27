import { describe, expect, it } from "vitest";
import type { Site } from "../../src/lib/api";
import { isEmpty, isoView, planView, WALL_HEIGHT_M, zoneAnchor, zoneLabel } from "../../src/scene/layout";

const SITE: Site = { id: "s", name: "站点", width_m: 40, height_m: 24, walls: [], zones: [], devices: [] };
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
