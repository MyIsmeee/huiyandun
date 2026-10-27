import { beforeEach, describe, expect, it } from "vitest";
import type { components } from "../../src/api/schema";
import { type Device, prune, receive, TRACK_TTL_MS, TRAIL_MS, useLive } from "../../src/store/live";

type Frame = components["schemas"]["WsFrame"];
const BASE = { schema_version: "1.0.0", event_id: "00000000-0000-4000-8000-000000000000", ts: "2026-10-27T06:30:00Z" };
const frame = (channel: Frame["channel"], data: object) => ({ channel, data }) as unknown as Frame;
const track = (x: number, track_id = 1) =>
  frame("tracks", { ...BASE, camera_id: "cam-01", track_id, x, y: 5, uncertainty_m: 0.4 });
const person = (track_id = 1) => useLive.getState().people[`cam-01/${track_id}`];

beforeEach(() => useLive.setState(useLive.getInitialState()));

describe("tracks", () => {
  it("收到位置即投放化身，后续位置更新坐标并追加轨迹", () => {
    receive(track(1), 0);
    receive(track(2), 500);

    expect(person()).toMatchObject({ camera_id: "cam-01", track_id: 1, x: 2, y: 5, uncertainty_m: 0.4 });
    expect(person()?.trail).toEqual([
      [1, 5, 0],
      [2, 5, 500],
    ]);
  });

  it("轨迹只保留近 10 s（V-A5）", () => {
    receive(track(1), 0);
    receive(track(2), 1000);
    receive(track(3), TRAIL_MS + 1000);

    expect(person()?.trail.map(([x]) => x)).toEqual([2, 3]);
  });

  it("超过 2 s 无位置更新即移除，未超过的保留（V-U4）", () => {
    receive(track(1, 1), 0);
    receive(track(1, 2), 1000);

    prune(TRACK_TTL_MS + 1);

    expect(person(1)).toBeUndefined();
    expect(person(2)).toBeDefined();
  });

  it("无变化时不更新状态，避免无谓重绘", () => {
    receive(track(1), 0);
    const before = useLive.getState();

    prune(100);

    expect(useLive.getState()).toBe(before);
  });
});

describe("devices 与 alerts", () => {
  it("设备状态以推送为准", () => {
    const device = { id: "cam-02", state: "cyber_alert" } as Device;

    receive(frame("devices", device), 0);

    expect(useLive.getState().devices["cam-02"]).toEqual(device);
  });

  it("按摄像头记录最近一次行为事件，网络告警不计入", () => {
    const fall = { ...BASE, camera_id: "cam-01", track_id: 1, behavior: "fall", confidence_avg: 0.9 };

    receive(frame("alerts", fall), 0);
    receive(frame("alerts", { ...BASE, rule_id: "HYD-NET-0001", device_id: "cam-01" }), 0);

    expect(useLive.getState().behaviors).toEqual({ "cam-01": fall });
  });

  it("设备退出物理告警即清除其行为事件：再次告警时不显示上一次的事件", () => {
    const fall = { ...BASE, camera_id: "cam-01", track_id: 1, behavior: "fall" };
    receive(frame("alerts", fall), 0);
    receive(frame("devices", { id: "cam-01", state: "both" }), 0);
    expect(useLive.getState().behaviors).toEqual({ "cam-01": fall });

    receive(frame("devices", { id: "cam-01", state: "normal" }), 0);

    expect(useLive.getState().behaviors).toEqual({});
  });

  it("按设备记录处于网络攻击期间的最高告警等级；无设备的告警不计入；退出网络攻击即清除（V-A1）", () => {
    const alert = (severity: string, device_id: string | null = "cam-02") =>
      frame("alerts", { ...BASE, rule_id: "HYD-NET-0001", severity, device_id });

    receive(alert("medium"), 0);
    receive(alert("high"), 0);
    receive(alert("low"), 0);
    receive(alert("critical", null), 0);
    expect(useLive.getState().severities).toEqual({ "cam-02": "high" });

    receive(frame("devices", { id: "cam-02", state: "both" }), 0);
    expect(useLive.getState().severities).toEqual({ "cam-02": "high" });
    receive(frame("devices", { id: "cam-02", state: "contained" }), 0);
    expect(useLive.getState().severities).toEqual({});
  });
});
