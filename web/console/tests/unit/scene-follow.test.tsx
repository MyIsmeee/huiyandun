import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FLIGHT_MS, focusOn, moveCamera, rotated, useCamera, useFocusShot } from "../../src/scene/camera";
import type { Camera } from "../../src/scene/devices";
import { cameraShot, followShot, OVERVIEW, type Shot } from "../../src/scene/layout";
import { RENDER_DELAY_MS } from "../../src/scene/targets";
import { type Target, useLive } from "../../src/store/live";

const SIZE = { width: 1000, height: 600 };
const BASE: Shot = { eye: [20, 30, 30], look: [20, 0, 12], fov: 0.6, center: [500, 330] };
const POSE = { x: 0, y: 0, height_m: 3, yaw_deg: 0, pitch_deg: -30, hfov_deg: 90, range_m: 15 };
const CAMERAS: Camera[] = [{ id: "cam-01", state: "normal", calibrated: true, severe: false, pose: POSE }];
const KEY = "cam-01/7";

const target = (patch: Partial<Target>): Target => ({
  camera_id: "cam-01",
  track_id: 7,
  object_class: "person",
  x: 10,
  y: 0,
  uncertainty_m: 0.4,
  heading_deg: null,
  speed_mps: null,
  bbox: [0, 0, 1, 1],
  keypoints: null,
  trail: [[10, 0, 0]],
  ...patch,
});

const render = (motion = true) => renderHook(() => useFocusShot(BASE, SIZE, CAMERAS, motion));
/** 推进 ms 毫秒：动画帧与时钟一并推进 */
const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance", "Date"] });
  useCamera.setState(useCamera.getInitialState());
  useLive.setState({ targets: { [KEY]: target({ trail: [[10, 0, Date.now()]] }) } });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("跟随视角（V-I1、D-058）", () => {
  it("总览：直接取总览机位", () => {
    expect(render().result.current).toBe(BASE);
  });

  it(`飞入跟随视角：${FLIGHT_MS} ms 内由当前机位到达目标后上方`, () => {
    const { result } = render();
    act(() => focusOn({ kind: "target", key: KEY }, true));
    advance(FLIGHT_MS / 2);
    const middle = result.current;
    expect(middle?.eye[1]).toBeLessThan(BASE.eye[1]);
    expect(middle?.eye[1]).toBeGreaterThan(4);

    advance(FLIGHT_MS + 50); // 到位发生在越过时长后的下一帧
    expect(result.current).toEqual(followShot([10, 0], Math.PI, SIZE));
    expect(useCamera.getState().flight).toBeNull();
  });

  it("人员：视点在所属摄像头一侧，人形姿态与画面一致", () => {
    const { result } = render();
    act(() => focusOn({ kind: "target", key: KEY }, false));
    // 摄像头在原点、人员在 (10, 0)：视点在人员朝摄像头的 -x 一侧
    expect(result.current).toEqual(followShot([10, 0], Math.PI, SIZE));
  });

  it("车辆：视点在车尾一侧；转向时机位平顺转过去，不瞬间翻转", () => {
    useLive.setState({ targets: { [KEY]: target({ object_class: "car", heading_deg: 90, trail: [[10, 0, Date.now()]] }) } });
    const { result } = render();
    act(() => focusOn({ kind: "target", key: KEY }, false));
    // 驶向 +y，视点在 -y 一侧
    expect(result.current?.eye[0]).toBeCloseTo(10);
    expect(result.current?.eye[2]).toBeCloseTo(-8);

    act(() => useLive.setState({ targets: { [KEY]: target({ object_class: "car", heading_deg: 0, trail: [[10, 0, Date.now()]] }) } }));
    advance(16);
    const turning = result.current;
    expect(turning).not.toEqual(followShot([10, 0], Math.PI, SIZE));
    advance(2000);
    expect(result.current?.eye[0]).toBeCloseTo(2); // 驶向 +x，视点转到车尾 -x 一侧
    expect(result.current?.eye[2]).toBeCloseTo(0);
  });

  it("视点随目标移动：在相邻两次实测之间插值，与目标模型同一渲染时间轴", () => {
    const start = Date.now();
    useLive.setState({ targets: { [KEY]: target({ trail: [[10, 0, start], [12, 0, start + 400]] }) } });
    const { result } = render();
    act(() => focusOn({ kind: "target", key: KEY }, false));
    advance(400);
    // 渲染时刻 start + 400 - 200：两次实测的正中
    expect(result.current?.eye[0]).toBeCloseTo(11 - 8, 1);
    expect(RENDER_DELAY_MS).toBe(200);
    advance(400);
    expect(result.current?.eye[0]).toBeCloseTo(12 - 8);
  });

  it("飞行中可被打断：返回总览从当前机位出发，不跳变，到位后按总览取景", () => {
    const { result } = render();
    act(() => focusOn({ kind: "target", key: KEY }, true));
    advance(FLIGHT_MS / 2);
    const middle = result.current;

    act(() => focusOn(null, true));
    advance(16);
    const after = result.current;
    expect(Math.abs((after?.eye[1] ?? 0) - (middle?.eye[1] ?? 0))).toBeLessThan(1);

    advance(FLIGHT_MS + 50); // 到位发生在越过时长后的下一帧
    expect(result.current).toBe(BASE);
    expect(useCamera.getState()).toMatchObject({ focus: null, flight: null, shot: null });
  });

  it("返回总览重置为默认机位", () => {
    moveCamera(rotated(OVERVIEW, 1), false);
    act(() => focusOn({ kind: "target", key: KEY }, false));
    act(() => focusOn(null, false));
    expect(useCamera.getState().pose).toEqual(OVERVIEW);
  });

  it("跟随的目标离开画面：飞回总览", () => {
    const { result } = render();
    act(() => focusOn({ kind: "target", key: KEY }, false));
    act(() => useLive.setState({ targets: {} }));
    expect(useCamera.getState().focus).toBeNull();
    advance(FLIGHT_MS + 50); // 到位发生在越过时长后的下一帧
    expect(result.current).toBe(BASE);
  });

  it("降低动效或断线：瞬时到位，停在最新实测位置", () => {
    const start = Date.now();
    useLive.setState({ targets: { [KEY]: target({ trail: [[10, 0, start], [12, 0, start + 400]] }) } });
    const { result } = render(false);
    act(() => focusOn({ kind: "target", key: KEY }, false));
    expect(result.current).toEqual(followShot([12, 0], Math.PI, SIZE));
  });

  it("摄像头视角：在摄像头位置沿其朝向看出去", () => {
    const { result } = render();
    act(() => focusOn({ kind: "camera", id: "cam-01" }, false));
    expect(result.current).toEqual(cameraShot(POSE, SIZE));
  });
});
