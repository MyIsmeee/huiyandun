import { describe, expect, it } from "vitest";
import type { Site } from "../../src/lib/api";
import {
  blendShot,
  cameraShot,
  followShot,
  OVERVIEW,
  overviewShot,
  type Pose,
  planView,
  sceneView,
  type View,
  WALL_HEIGHT_M,
} from "../../src/scene/layout";

const SITE: Site = { id: "s", name: "站点", width_m: 40, height_m: 24, walls: [], doors: [], zones: [], devices: [] };
const SIZE = { width: 1100, height: 700 };
// 与 layout.ts 的 INSET 一致：顶部留出 KPI 底板，底部留出断线提示
const AREA = { left: 24, top: 112, right: SIZE.width - 24, bottom: SIZE.height - 56 };

function bounds(points: (readonly [number, number])[]) {
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  return { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) };
}

/** 透视总览视图 */
const overviewView = (site: Site, size: typeof SIZE, pose: Pose = OVERVIEW) => {
  const { shot, panLimit } = overviewShot(site, size, pose);
  return sceneView(shot, size, panLimit);
};
/** 投影一定在相机前方：断言后取值 */
const at = (view: View, p: readonly [number, number, number]) => {
  const point = view.project(p);
  expect(point).not.toBeNull();
  return point ?? ([0, 0] as const);
};

describe("sceneView", () => {
  const shot = { eye: [0, 10, 10] as const, look: [0, 0, 0] as const, fov: Math.PI / 2, center: [500, 300] as const };
  const view = sceneView(shot, SIZE);

  it("取景中心投影到 center 像素处；焦距按竖直视场与视口高度", () => {
    expect(view.project([0, 0, 0])).toEqual([500, 300]);
    // 视场 90°：焦距为半个视口高 350 像素，取景中心距视点 10√2 米
    expect(view.zoom).toBeCloseTo(350 / (10 * Math.SQRT2));
    expect(view.scale([0, 0, 0])).toBeCloseTo(view.zoom);
  });

  it("近大远小：更远处每米像素数更少", () => {
    expect(view.scale([0, 0, -10])).toBeLessThan(view.scale([0, 0, 5]));
  });

  it("在相机近裁面以内或身后的点不投影", () => {
    expect(view.project([0, 10, 10])).toBeNull();
    expect(view.project([0, 20, 20])).toBeNull();
  });
});

describe("透视总览", () => {
  const view = overviewView(SITE, SIZE);
  const corners = [0, WALL_HEIGHT_M].flatMap((y) =>
    [
      [0, 0],
      [40, 0],
      [40, 24],
      [0, 24],
    ].map(([x = 0, z = 0]) => at(view, [x, y, z])),
  );

  it("站点包围盒落在可用区域内，并贴到可用区域的边", () => {
    const box = bounds(corners);
    expect(box.left).toBeGreaterThanOrEqual(AREA.left - 1e-6);
    expect(box.right).toBeLessThanOrEqual(AREA.right + 1e-6);
    expect(box.top).toBeGreaterThanOrEqual(AREA.top - 1e-6);
    expect(box.bottom).toBeLessThanOrEqual(AREA.bottom + 1e-6);
    const fills = [box.left - AREA.left, AREA.right - box.right, box.top - AREA.top, AREA.bottom - box.bottom];
    expect(fills.some((gap) => Math.abs(gap) < 1e-6)).toBe(true);
  });

  it("站点中心对准可用区域中心", () => {
    const [x, y] = at(view, [20, 0, 12]);
    expect(x).toBeCloseTo((AREA.left + AREA.right) / 2);
    expect(y).toBeCloseTo((AREA.top + AREA.bottom) / 2);
  });

  it("原点在最远处（画面上方），x 向右下、y 向左下；近处每米像素数更多", () => {
    const [origin, east, south] = [at(view, [0, 0, 0]), at(view, [1, 0, 0]), at(view, [0, 0, 1])];
    expect(origin[1]).toBeLessThan(east[1]);
    expect(east[0]).toBeGreaterThan(origin[0]);
    expect(south[0]).toBeLessThan(origin[0]);
    expect(south[1]).toBeGreaterThan(origin[1]);
    expect(view.scale([40, 0, 24])).toBeGreaterThan(view.scale([0, 0, 0]));
  });

  it("大站点的包围盒也完整落在相机可见深度内", () => {
    const v = overviewView({ ...SITE, width_m: 400, height_m: 300 }, SIZE);
    for (const x of [0, 400]) for (const y of [0, WALL_HEIGHT_M]) for (const z of [0, 300]) at(v, [x, y, z]);
    const { eye } = v.shot;
    expect(Math.hypot(eye[0] - 400, eye[1], eye[2] - 300)).toBeLessThan(v.far);
  });

  it("俯角 45°，从东南方看向站点中心", () => {
    const { eye, look } = view.shot;
    const [dx, dy, dz] = [eye[0] - look[0], eye[1] - look[1], eye[2] - look[2]];
    expect(dy).toBeCloseTo(Math.hypot(dx, dz));
    expect(dx).toBeCloseTo(dz);
    expect(dx).toBeGreaterThan(0);
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

// V-I1：绕竖轴旋转 4 档、缩放 1～4 倍、放大后平移
describe("相机姿态", () => {
  const QUARTERS = [0, 1, 2, 3].map((k) => (k * Math.PI) / 2);
  const box = (view: View, heights: number[]) =>
    bounds(
      heights.flatMap((y) =>
        [
          [0, 0],
          [40, 0],
          [40, 24],
          [0, 24],
        ].map(([x = 0, z = 0]) => at(view, [x, y, z])),
      ),
    );
  const angle = (view: View, [x, y]: readonly [number, number]) => {
    const [cx, cy] = at(view, [20, 0, 12]);
    const [px, py] = at(view, [x, 0, y]);
    return Math.atan2(py - cy, px - cx); // 画面 y 向下，角度增大为顺时针
  };

  it.each(QUARTERS)("方位角 %f：透视总览与 2D 平面图都完整落在可用区域内，2D 平面图居中", (azimuth) => {
    const pose = { ...OVERVIEW, azimuth };
    const plan = box(planView(SITE, SIZE, pose), [0]);
    for (const b of [box(overviewView(SITE, SIZE, pose), [0, WALL_HEIGHT_M]), plan]) {
      expect(b.left).toBeGreaterThanOrEqual(AREA.left - 1e-6);
      expect(b.right).toBeLessThanOrEqual(AREA.right + 1e-6);
      expect(b.top).toBeGreaterThanOrEqual(AREA.top - 1e-6);
      expect(b.bottom).toBeLessThanOrEqual(AREA.bottom + 1e-6);
    }
    expect(plan.left - AREA.left).toBeCloseTo(AREA.right - plan.right);
    expect(plan.top - AREA.top).toBeCloseTo(AREA.bottom - plan.bottom);
  });

  it("方位角增大一档，场景在画面上顺时针转 90°", () => {
    const before = angle(overviewView(SITE, SIZE), [30, 12]);
    const after = angle(overviewView(SITE, SIZE, { ...OVERVIEW, azimuth: Math.PI / 2 }), [30, 12]);
    const delta = (after - before + 2 * Math.PI) % (2 * Math.PI);
    expect(delta).toBeGreaterThan(0);
    expect(delta).toBeLessThan(Math.PI);

    const [x, y] = planView(SITE, SIZE, { ...OVERVIEW, azimuth: Math.PI / 2 }).project([30, 0, 12]);
    const [cx, cy] = planView(SITE, SIZE, { ...OVERVIEW, azimuth: Math.PI / 2 }).project([20, 0, 12]);
    expect(x).toBeCloseTo(cx); // 东侧的点转到正下方
    expect(y).toBeGreaterThan(cy);
  });

  it("放大 2 倍：每米像素数加倍；2D 平面图以可用区域中心为锚点", () => {
    for (const make of [overviewView, planView]) {
      expect(make(SITE, SIZE, { ...OVERVIEW, zoom: 2 }).zoom).toBeCloseTo(2 * make(SITE, SIZE).zoom);
    }
    const center = planView(SITE, SIZE, { ...OVERVIEW, zoom: 2 }).project([20, 0, 12]);
    expect(center[0]).toBeCloseTo((AREA.left + AREA.right) / 2);
    expect(center[1]).toBeCloseTo((AREA.top + AREA.bottom) / 2);
  });

  it("平移 1 米：画面内容反向移动 zoom 个像素", () => {
    for (const make of [overviewView, planView]) {
      const pose = { ...OVERVIEW, zoom: 2 };
      const [x0, y0] = at(make(SITE, SIZE, pose), [20, 0, 12]);
      const [x1, y1] = at(make(SITE, SIZE, { ...pose, pan: [1, 1] }), [20, 0, 12]);
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

// V-I1、设计 §3.5：跟随视角与摄像头视角
describe("跟随与摄像头机位", () => {
  const degrees = (rad: number) => (rad * 180) / Math.PI;

  it("跟随：视点在目标 bearing 一侧水平 8 m、高 4 m，俯角 25° 看向目标，取景中心为视口中心", () => {
    const shot = followShot([10, 5], Math.PI / 2, SIZE);
    expect(shot.eye[0]).toBeCloseTo(10);
    expect(shot.eye[1]).toBe(4);
    expect(shot.eye[2]).toBeCloseTo(13);
    const [dx, dy, dz] = [shot.look[0] - shot.eye[0], shot.look[1] - shot.eye[1], shot.look[2] - shot.eye[2]];
    expect(degrees(Math.atan2(-dy, Math.hypot(dx, dz)))).toBeCloseTo(25);
    expect(dx).toBeCloseTo(0);
    expect(dz).toBeLessThan(0); // 朝目标看
    expect(shot.center).toEqual([SIZE.width / 2, SIZE.height / 2]);
    // 目标在画面中部偏下，人形（1.7 m）完整入画
    const view = sceneView(shot, SIZE);
    const [feet, head] = [at(view, [10, 0, 5]), at(view, [10, 1.7, 5])];
    expect(feet[0]).toBeCloseTo(SIZE.width / 2);
    expect(feet[1]).toBeGreaterThan(SIZE.height / 2);
    expect(feet[1]).toBeLessThan(SIZE.height);
    expect(head[1]).toBeGreaterThan(0);
  });

  it("摄像头视角：视点在机头，沿朝向与俯仰看出去，水平视场与摄像头一致", () => {
    const pose = { x: 2, y: 3, height_m: 3, yaw_deg: 90, pitch_deg: -30, hfov_deg: 90 };
    const shot = cameraShot(pose, SIZE);
    expect(shot.eye).toEqual([2, 3, 3]);
    const [dx, dy, dz] = [shot.look[0] - 2, shot.look[1] - 3, shot.look[2] - 3];
    expect(dx).toBeCloseTo(0);
    expect(dz).toBeGreaterThan(0); // yaw 90°：朝平面 +y
    expect(degrees(Math.atan2(-dy, dz))).toBeCloseTo(30);
    // 与视线同深度、水平偏转 45° 的点落在视口左右边缘
    const view = sceneView(shot, SIZE);
    const ahead = [shot.look[0], shot.look[1], shot.look[2]] as const;
    const reach = Math.hypot(dx, dy, dz);
    expect(at(view, [ahead[0] + reach, ahead[1], ahead[2]])[0]).toBeCloseTo(0);
    expect(at(view, [ahead[0] - reach, ahead[1], ahead[2]])[0]).toBeCloseTo(SIZE.width);
  });

  it("机位插值：两端分别为出发与目标机位", () => {
    const a = followShot([0, 0], 0, SIZE);
    const b = cameraShot({ x: 5, y: 5, height_m: 3, yaw_deg: 0, pitch_deg: -30, hfov_deg: 60 }, SIZE);
    expect(blendShot(a, b, 0)).toEqual(a);
    expect(blendShot(a, b, 1).eye).toEqual(b.eye);
    expect(blendShot(a, b, 0.5).fov).toBeCloseTo((a.fov + b.fov) / 2);
  });
});
