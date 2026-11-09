import { beforeEach, describe, expect, it } from "vitest";
import type { components } from "../../src/api/schema";
import { type Device, prune, receive, TRACK_TTL_MS, TRAIL_MS, useLive } from "../../src/store/live";

type Frame = components["schemas"]["WsFrame"];
const BASE = { schema_version: "1.0.0", event_id: "00000000-0000-4000-8000-000000000000", ts: "2026-10-27T06:30:00Z" };
const frame = (channel: Frame["channel"], data: object) => ({ channel, data }) as unknown as Frame;
const track = (x: number, track_id = 1) =>
  frame("tracks", {
    ...BASE,
    camera_id: "cam-01",
    track_id,
    object_class: "car",
    x,
    y: 5,
    uncertainty_m: 0.4,
    heading_deg: 90,
    speed_mps: 2,
    bbox: [0.1, 0.2, 0.3, 0.4],
    keypoints: null,
  });
const person = (track_id = 1) => useLive.getState().targets[`cam-01/${track_id}`];

beforeEach(() => useLive.setState(useLive.getInitialState()));

describe("tracks", () => {
  it("收到位置即投放目标（含类别、朝向、速度、检测框与关键点），后续位置更新坐标并追加轨迹", () => {
    receive(track(1), 0);
    receive(track(2), 500);

    expect(person()).toMatchObject({
      camera_id: "cam-01",
      track_id: 1,
      object_class: "car",
      x: 2,
      y: 5,
      uncertainty_m: 0.4,
      heading_deg: 90,
      speed_mps: 2,
      bbox: [0.1, 0.2, 0.3, 0.4],
      keypoints: null,
    });
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
});

describe("站点推送（D-101）", () => {
  const device = (id: string, name = id) =>
    ({ id, name, type: "camera", ip: "10.0.0.1", mode: "host_probe", state: "normal", alert_severity: null, camera: null }) as const;

  it("删除的摄像头移除推送状态；保留的沿用当前状态、登记信息取新站点", () => {
    receive({ channel: "devices", data: { ...device("cam-01"), state: "cyber_alert", alert_severity: "high" } } as never, 0);
    receive({ channel: "devices", data: device("cam-02") } as never, 0);
    receive({ channel: "site", data: { id: "s", name: "s", width_m: 1, height_m: 1, areas: [], devices: [device("cam-01", "大门口"), device("cam-03")] } } as never, 0);

    const { site, devices } = useLive.getState();
    expect(site?.devices.map((d) => d.id)).toEqual(["cam-01", "cam-03"]);
    expect(Object.keys(devices)).toEqual(["cam-01", "cam-03"]);
    expect(devices["cam-01"]).toMatchObject({ name: "大门口", state: "cyber_alert", alert_severity: "high" });
  });
});

describe("站点推送移除已删除摄像头的目标", () => {
  it("目标随摄像头删除立即移除", () => {
    useLive.setState({ targets: { "cam-02/1": { camera_id: "cam-02" } as never, "cam-01/1": { camera_id: "cam-01" } as never } });
    const device = { id: "cam-01", name: "cam-01", type: "camera", ip: "10.0.0.1", mode: "host_probe", state: "normal", alert_severity: null, camera: null };
    receive({ channel: "site", data: { id: "s", name: "s", width_m: 1, height_m: 1, areas: [], devices: [device] } } as never, 0);
    expect(Object.keys(useLive.getState().targets)).toEqual(["cam-01/1"]);
  });
});
