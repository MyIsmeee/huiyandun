import { describe, expect, it } from "vitest";
import type { Camera, DeviceState } from "../../src/scene/devices";
import type { View } from "../../src/scene/layout";
import {
  coneOpacity,
  detectingByCamera,
  HIGH_ERROR_M,
  pickTarget,
  positionAt,
  targetLabel,
  turnToward,
  visibleTargets,
} from "../../src/scene/targets";
import type { Behavior, Target, TargetClass } from "../../src/store/live";

const pose = { x: 0, y: 0, height_m: 3, yaw_deg: 0, pitch_deg: -30, hfov_deg: 90, range_m: 10 };
const cam = (state: DeviceState, calibrated = true): Camera => ({ id: "cam-01", state, calibrated, severe: false, pose });
const target = (track_id: number, uncertainty_m = 0.4, camera_id = "cam-01", object_class: TargetClass = "person"): Target => ({
  camera_id,
  track_id,
  object_class,
  x: 1,
  y: 2,
  uncertainty_m,
  heading_deg: null,
  speed_mps: null,
  bbox: [0, 0, 1, 1],
  keypoints: null,
  trail: [[1, 2, 0]],
});
const targets = (...list: Target[]) => Object.fromEntries(list.map((p) => [`${p.camera_id}/${p.track_id}`, p]));
const fall = (track_id: number) => ({ camera_id: "cam-01", track_id, behavior: "fall" }) as Behavior;

describe("visibleTargets", () => {
  it("已标定摄像头的目标按正常态投放", () => {
    expect(visibleTargets(targets(target(1)), [cam("normal")], {})).toEqual([
      expect.objectContaining({ key: "cam-01/1", x: 1, y: 2, uncertainty_m: 0.4, alert: false, uncertain: false }),
    ]);
  });

  it("未登记的摄像头不投放目标", () => {
    expect(visibleTargets(targets(target(1, 0.4, "cam-x")), [cam("normal")], {})).toEqual([]);
  });

  it("以标定点判断未标定：处于物理告警的未标定摄像头同样不投放（V-U2）", () => {
    expect(visibleTargets(targets(target(1)), [cam("physical_alert", false)], { "cam-01": fall(1) })).toEqual([]);
  });

  it("误差超过 1 m 为高误差，恰为 1 m 不算（V-U1）", () => {
    const list = visibleTargets(targets(target(1, HIGH_ERROR_M), target(2, HIGH_ERROR_M + 0.01)), [cam("normal")], {});

    expect(list.map((a) => a.uncertain)).toEqual([false, true]);
  });

  it.each([
    ["physical_alert", true],
    ["both", true],
    ["contained", false],
  ] as const)("摄像头为 %s 时，行为事件对应的人员告警：%s", (state, alert) => {
    const list = visibleTargets(targets(target(1), target(2)), [cam(state)], { "cam-01": fall(2) });

    expect(list.map((a) => a.alert)).toEqual([false, alert]);
  });

  it("行为事件只指向人员：编号相同的车辆不转告警", () => {
    const list = visibleTargets(targets(target(2, 0.4, "cam-01", "car")), [cam("physical_alert")], { "cam-01": fall(2) });

    expect(list.map((a) => a.alert)).toEqual([false]);
  });
});

describe("positionAt", () => {
  const trail = [
    [0, 0, 1000],
    [2, 4, 1200],
    [4, 4, 1400],
  ] as const satisfies Target["trail"];

  it("在相邻两次实测之间线性插值", () => {
    expect(positionAt(trail, 1100)).toEqual([1, 2]);
    expect(positionAt(trail, 1300)).toEqual([3, 4]);
  });

  it("不外推：晚于最后一次实测停在最后位置（FR-102）", () => {
    expect(positionAt(trail, 5000)).toEqual([4, 4]);
  });

  it("早于第一次实测取第一次位置", () => {
    expect(positionAt(trail, 0)).toEqual([0, 0]);
  });
});

describe("turnToward", () => {
  it("每步最多转 maxStep", () => {
    expect(turnToward(0, Math.PI / 2, 0.1)).toBeCloseTo(0.1);
  });

  it("走最短方向：从 350° 到 10° 正转 20°，而不是反转 340°", () => {
    const from = (350 * Math.PI) / 180;
    const to = (10 * Math.PI) / 180;

    expect(turnToward(from, to, 1)).toBeCloseTo(from + (20 * Math.PI) / 180);
  });
});

describe("coneOpacity", () => {
  it.each([
    [0, 0.12],
    [1, 0.2],
    [3, 0.24],
    [20, 0.28],
  ])("检出 %i 个目标时不透明度为 %f", (detecting, opacity) => {
    expect(coneOpacity(0.12, detecting)).toBeCloseTo(opacity);
  });
});

describe("detectingByCamera", () => {
  it("按摄像头统计当前目标数", () => {
    const counts = detectingByCamera(targets(target(1), target(2), target(3, 0.4, "cam-02")));

    expect(counts).toEqual({ "cam-01": 2, "cam-02": 1 });
  });
});

describe("targetLabel", () => {
  it("类别 · 跟踪号 · 速度（km/h 取整）；尚无速度时不显示（D-054）", () => {
    expect(targetLabel({ ...target(7), speed_mps: 1.25 })).toBe("人员 · #7 · 5 km/h");
    expect(targetLabel({ ...target(1000001, 0.4, "cam-01", "bus"), speed_mps: null })).toBe("公交 · #1000001");
  });
});

describe("pickTarget", () => {
  // 俯视：每米 10 像素，场景 (x, *, y) 投影到 (10x, 10y)
  const view: View = { zoom: 10, project: ([x, , z]) => [x * 10, z * 10], scale: () => 10, panLimit: [0, 0] };
  const list = visibleTargets(
    targets({ ...target(1), x: 1, y: 2, trail: [[1, 2, 0]] }, { ...target(2, 0.4, "cam-01", "bus"), trail: [[10, 2, 0]] }),
    [cam("normal")],
    {},
  );

  it("命中半径内取最近的目标；人员半径不足 20 像素时按 20 像素", () => {
    expect(pickTarget(list, view, [10 + 19, 20], 0)).toBe("cam-01/1");
    expect(pickTarget(list, view, [10 + 21, 20], 0)).toBeNull();
  });

  it("车辆按模型半长命中", () => {
    expect(pickTarget(list, view, [100 + 39, 20], 0)).toBe("cam-01/2");
  });

  it("透视：命中半径按目标处的每米像素数；在相机身后的目标不命中", () => {
    const perspective: View = { ...view, scale: ([x]) => (x > 5 ? 5 : 10) };
    expect(pickTarget(list, perspective, [100 + 19, 20], 0)).toBe("cam-01/2");
    expect(pickTarget(list, perspective, [100 + 21, 20], 0)).toBeNull();
    const behind: View = { ...view, project: ([x, y, z]) => (x > 5 ? null : view.project([x, y, z])) };
    expect(pickTarget(list, behind, [100, 20], 0)).toBeNull();
  });
});
