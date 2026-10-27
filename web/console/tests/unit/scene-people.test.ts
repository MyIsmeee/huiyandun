import { describe, expect, it } from "vitest";
import type { Camera, DeviceState } from "../../src/scene/devices";
import { avatars, HIGH_ERROR_M } from "../../src/scene/people";
import type { Behavior, Person } from "../../src/store/live";

const pose = { x: 0, y: 0, height_m: 3, yaw_deg: 0, pitch_deg: -30, hfov_deg: 90, range_m: 10 };
const cam = (state: DeviceState, calibrated = true): Camera => ({ id: "cam-01", state, calibrated, severe: false, pose });
const person = (track_id: number, uncertainty_m = 0.4, camera_id = "cam-01"): Person => ({
  camera_id,
  track_id,
  x: 1,
  y: 2,
  uncertainty_m,
  trail: [[1, 2, 0]],
});
const people = (...list: Person[]) => Object.fromEntries(list.map((p) => [`${p.camera_id}/${p.track_id}`, p]));
const fall = (track_id: number) => ({ camera_id: "cam-01", track_id, behavior: "fall" }) as Behavior;

describe("avatars", () => {
  it("已标定摄像头的人员按正常态投放", () => {
    expect(avatars(people(person(1)), [cam("normal")], {})).toEqual([
      expect.objectContaining({ key: "cam-01/1", x: 1, y: 2, uncertainty_m: 0.4, alert: false, uncertain: false }),
    ]);
  });

  it("未登记的摄像头不投放化身", () => {
    expect(avatars(people(person(1, 0.4, "cam-x")), [cam("normal")], {})).toEqual([]);
  });

  it("以标定点判断未标定：处于物理告警的未标定摄像头同样不投放（V-U2）", () => {
    expect(avatars(people(person(1)), [cam("physical_alert", false)], { "cam-01": fall(1) })).toEqual([]);
  });

  it("误差超过 1 m 为高误差，恰为 1 m 不算（V-U1）", () => {
    const list = avatars(people(person(1, HIGH_ERROR_M), person(2, HIGH_ERROR_M + 0.01)), [cam("normal")], {});

    expect(list.map((a) => a.uncertain)).toEqual([false, true]);
  });

  it.each([
    ["physical_alert", true],
    ["both", true],
    ["contained", false],
  ] as const)("摄像头为 %s 时，行为事件对应的人员告警：%s", (state, alert) => {
    const list = avatars(people(person(1), person(2)), [cam(state)], { "cam-01": fall(2) });

    expect(list.map((a) => a.alert)).toEqual([false, alert]);
  });
});
