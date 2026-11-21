import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  adjustOrbit,
  adjustZoom,
  moveCamera,
  NO_ADJUST,
  orbited,
  overview,
  panned,
  rotated,
  TILT_RANGE,
  TRANSITION_MS,
  useCamera,
  wheelZoomed,
  zoomed,
} from "../../src/scene/camera";
import { type Area, followShot, OVERVIEW, overviewShot, type Pose, sceneView } from "../../src/scene/layout";

const QUARTER = Math.PI / 2;
const AXO = Math.PI / 4;

describe("相机操作（V-I1、V-I5）", () => {
  it("缩放 4 档，限定在总览的 1～4 倍", () => {
    let pose = OVERVIEW;
    const zooms = [];
    for (let i = 0; i < 5; i += 1) zooms.push((pose = zoomed(pose, 1)).zoom);
    expect(zooms).toEqual([Math.SQRT2, 2, 2 * Math.SQRT2, 4, 4]);
    expect(zoomed(OVERVIEW, -1).zoom).toBe(1);
  });

  it("缩回总览倍数时取景回到中心", () => {
    const pose: Pose = { azimuth: 0, tilt: AXO, zoom: Math.SQRT2, pan: [3, 2] };
    expect(zoomed(pose, -1)).toEqual({ azimuth: 0, tilt: AXO, zoom: 1, pan: [0, 0] });
  });

  it("旋转 90°：方位加四分之一圈，保留缩放与俯角，平移归零（V-I5）", () => {
    const pose: Pose = { azimuth: 0, tilt: AXO, zoom: 2, pan: [3, 2] };
    expect(rotated(pose)).toEqual({ azimuth: QUARTER, tilt: AXO, zoom: 2, pan: [0, 0] });
    expect(rotated(rotated(rotated(rotated(pose)))).azimuth).toBeCloseTo(2 * Math.PI);
  });

  it("返回总览：方位角回到最近的整圈", () => {
    expect(overview({ azimuth: 3 * QUARTER, tilt: AXO, zoom: 4, pan: [1, 1] })).toEqual({ ...OVERVIEW, azimuth: 2 * Math.PI });
    expect(overview({ azimuth: QUARTER, tilt: AXO, zoom: 2, pan: [0, 0] })).toEqual(OVERVIEW);
  });

  it("拖拽平移：取景中心反向移动，不超出平移上限", () => {
    const pose: Pose = { azimuth: 0, tilt: AXO, zoom: 2, pan: [0, 0] };
    expect(panned(pose, [20, -10], 10, [5, 5]).pan).toEqual([-2, 1]);
    expect(panned(pose, [-200, 200], 10, [5, 3]).pan).toEqual([5, -3]);
  });
});

describe("moveCamera", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance"] });
    useCamera.setState(useCamera.getInitialState());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("瞬时切换：姿态立即到位（降低动效、断线）", () => {
    moveCamera(rotated(OVERVIEW), false);

    expect(useCamera.getState().pose.azimuth).toBe(QUARTER);
  });

  it(`转场在 ${TRANSITION_MS} ms 内完成（V-A2）`, () => {
    moveCamera(rotated(OVERVIEW), true);
    expect(useCamera.getState().pose.azimuth).toBe(0);
    expect(useCamera.getState().goal.azimuth).toBe(QUARTER);

    vi.advanceTimersByTime(TRANSITION_MS / 2);
    const middle = useCamera.getState().pose.azimuth;
    expect(middle).toBeGreaterThan(0);
    expect(middle).toBeLessThan(QUARTER);

    vi.advanceTimersByTime(TRANSITION_MS);
    expect(useCamera.getState().pose.azimuth).toBe(QUARTER);
  });

  it("转场中再次操作从当前位置出发，可被打断", () => {
    moveCamera(rotated(OVERVIEW), true);
    vi.advanceTimersByTime(TRANSITION_MS / 2);
    const middle = useCamera.getState().pose.azimuth;

    moveCamera(OVERVIEW, false);

    expect(useCamera.getState().pose).toEqual(OVERVIEW);
    vi.advanceTimersByTime(TRANSITION_MS);
    expect(useCamera.getState().pose).toEqual(OVERVIEW); // 被打断的转场不再推进
    expect(middle).not.toBe(0);
  });
});

describe("滚轮与拖拽（V-I1）", () => {
  const SITE: Area = { x0: 0, y0: 0, width_m: 12, height_m: 8 };
  const SIZE = { width: 1100, height: 700 };
  const viewOf = (pose: Pose) => {
    const { shot, panLimit } = overviewShot(SITE, SIZE, pose);
    return sceneView(shot, SIZE, panLimit);
  };

  it("滚轮以光标为中心缩放：光标下的地面点缩放前后留在原处", () => {
    const before = viewOf(OVERVIEW);
    const ground: [number, number, number] = [8, 0, 2];
    const cursor = before.project(ground);
    if (!cursor) throw new Error("点不在画面中");
    const offset = [cursor[0] - before.shot.center[0], cursor[1] - before.shot.center[1]] as const;
    const pose = wheelZoomed(OVERVIEW, -300, offset, before.zoom, before.panLimit);
    expect(pose.zoom).toBeGreaterThan(1.5);
    const after = viewOf(pose).project(ground);
    expect(after?.[0]).toBeCloseTo(cursor[0], -1); // 透视下只在取景中心深度处严格成立，相差不到 10 像素
    expect(after?.[1]).toBeCloseTo(cursor[1], -1);
  });

  it("滚轮缩放限定在 1～4 倍，缩到最小时平移归零", () => {
    const zoomedIn: Pose = { ...OVERVIEW, zoom: 2, pan: [1, 1] };
    expect(wheelZoomed(zoomedIn, -10000, [0, 0], 50, [5, 5]).zoom).toBe(4);
    expect(wheelZoomed(zoomedIn, 10000, [300, 0], 50, [5, 5])).toEqual({ ...zoomedIn, zoom: 1, pan: [0, 0] });
    // 平移不超出上限
    expect(wheelZoomed(OVERVIEW, -1000, [5000, 0], 10, [3, 3]).pan[0]).toBe(3);
  });

  it("拖拽旋转：向右拖时方位减小，向下拖时俯角增大，俯角限定在范围内", () => {
    const pose = orbited(OVERVIEW, [100, 50]);
    expect(pose.azimuth).toBeLessThan(0);
    expect(pose.tilt).toBeGreaterThan(OVERVIEW.tilt);
    expect(orbited(OVERVIEW, [0, 10000]).tilt).toBe(TILT_RANGE[1]);
    expect(orbited(OVERVIEW, [0, -10000]).tilt).toBe(TILT_RANGE[0]);
  });

  it("跟随视角：滚轮推远拉近、拖动绕目标转动，并限定范围", () => {
    expect(adjustZoom(NO_ADJUST, 300).distance).toBeGreaterThan(1);
    expect(adjustZoom(NO_ADJUST, -100000).distance).toBeCloseTo(0.35);
    const turned = adjustOrbit(NO_ADJUST, [100, 0]);
    expect(turned.turn).toBeLessThan(0);
    const near = followShot([0, 0], 0, SIZE);
    const far = followShot([0, 0], 0, SIZE, 2);
    expect(far.eye[0]).toBeCloseTo(near.eye[0] * 2);
    const high = followShot([0, 0], 0, SIZE, 1, adjustOrbit(NO_ADJUST, [0, 100000]).lift);
    expect(high.eye[1] / Math.hypot(high.eye[0], high.eye[2])).toBeCloseTo(Math.tan((80 * Math.PI) / 180), 3);
    expect(followShot([0, 0], 0, SIZE, 1, 0)).toEqual(near);
  });
});
