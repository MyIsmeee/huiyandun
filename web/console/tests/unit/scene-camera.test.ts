import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { moveCamera, overview, panned, rotated, TRANSITION_MS, useCamera, zoomed } from "../../src/scene/camera";
import { OVERVIEW, type Pose } from "../../src/scene/layout";

const QUARTER = Math.PI / 2;

describe("相机操作（V-I1、V-I5）", () => {
  it("缩放 4 档，限定在总览的 1～4 倍", () => {
    let pose = OVERVIEW;
    const zooms = [];
    for (let i = 0; i < 5; i += 1) zooms.push((pose = zoomed(pose, 1)).zoom);
    expect(zooms).toEqual([Math.SQRT2, 2, 2 * Math.SQRT2, 4, 4]);
    expect(zoomed(OVERVIEW, -1).zoom).toBe(1);
  });

  it("缩回总览倍数时取景回到中心", () => {
    const pose: Pose = { azimuth: 0, zoom: Math.SQRT2, pan: [3, 2] };
    expect(zoomed(pose, -1)).toEqual({ azimuth: 0, zoom: 1, pan: [0, 0] });
  });

  it("旋转一档为 90°，保留缩放，平移归零", () => {
    const pose: Pose = { azimuth: 0, zoom: 2, pan: [3, 2] };
    expect(rotated(pose, 1)).toEqual({ azimuth: QUARTER, zoom: 2, pan: [0, 0] });
    expect(rotated(pose, -1).azimuth).toBe(-QUARTER);
  });

  it("返回总览：方位角回到最近的整圈", () => {
    expect(overview({ azimuth: 3 * QUARTER, zoom: 4, pan: [1, 1] })).toEqual({ ...OVERVIEW, azimuth: 2 * Math.PI });
    expect(overview({ azimuth: QUARTER, zoom: 2, pan: [0, 0] })).toEqual(OVERVIEW);
  });

  it("拖拽平移：取景中心反向移动，不超出平移上限", () => {
    const pose: Pose = { azimuth: 0, zoom: 2, pan: [0, 0] };
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
    moveCamera(rotated(OVERVIEW, 1), false);

    expect(useCamera.getState().pose.azimuth).toBe(QUARTER);
  });

  it(`转场在 ${TRANSITION_MS} ms 内完成（V-A2）`, () => {
    moveCamera(rotated(OVERVIEW, 1), true);
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
    moveCamera(rotated(OVERVIEW, 1), true);
    vi.advanceTimersByTime(TRANSITION_MS / 2);
    const middle = useCamera.getState().pose.azimuth;

    moveCamera(OVERVIEW, false);

    expect(useCamera.getState().pose).toEqual(OVERVIEW);
    vi.advanceTimersByTime(TRANSITION_MS);
    expect(useCamera.getState().pose).toEqual(OVERVIEW); // 被打断的转场不再推进
    expect(middle).not.toBe(0);
  });
});
