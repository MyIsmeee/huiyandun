import { describe, expect, it } from "vitest";
import { attackerAnchor, attackSources, containedSince, DASH, fadeElapsed, OUTSIDE_M } from "../../src/scene/attack";
import css from "../../src/theme/theme.css?raw";
import type { Alert, Execution, Incident } from "../../src/store/live";

describe("attackerAnchor（D-076）", () => {
  it.each([
    [[2, 12], [-OUTSIDE_M, 12]], // 最近左边
    [[38, 12], [40 + OUTSIDE_M, 12]], // 最近右边
    [[20, 1], [20, -OUTSIDE_M]], // 最近上边
    [[20, 22], [20, 24 + OUTSIDE_M]], // 最近下边
  ] as const)("设备 %j 的攻击源在区域最近边缘外 %j", (device, anchor) => {
    expect(attackerAnchor(device, { x0: 0, y0: 0, width_m: 40, height_m: 24 })).toEqual(anchor);
  });
});

const execution = (patch: Partial<Execution>): Execution =>
  ({
    id: "exec-1",
    incident_id: "inc-1",
    device_ids: ["cam-01"],
    target: "172.30.0.100",
    state: "contained",
    ttl_s: 1800,
    expires_at: "2026-11-14T10:30:00.000Z",
    ...patch,
  }) as Execution;

describe("attackSources（D-076）", () => {
  it("取最近一条网络告警的源地址；告警被挤出后退回关联事件的来源，再退回执行的目标", () => {
    const alerts = [{ event_id: "a", device_id: "cam-01", src_ip: "10.0.0.1" }] as unknown as Alert[];
    const incidents = [{ id: "inc-2", device_ids: ["cam-01", "cam-02"], source_ip: "10.0.0.2" }] as unknown as Incident[];
    const executions = { "exec-1": execution({ device_ids: ["cam-03"], target: "10.0.0.3" }) };
    const sources = attackSources(alerts, incidents, executions);
    expect(sources.get("cam-01")).toBe("10.0.0.1");
    expect(sources.get("cam-02")).toBe("10.0.0.2");
    expect(sources.get("cam-03")).toBe("10.0.0.3");
  });
});

describe("containedSince：断开连线的淡出按进入已处置的时刻计进度", () => {
  it("优先取执行的生效时刻（到期减封禁时长），重新挂载时不变", () => {
    const executions = { "exec-1": execution({}) };
    const at = Date.parse("2026-11-14T10:00:00.000Z");
    expect(containedSince("cam-01", true, executions, at + 60_000)).toBe(at);
    expect(containedSince("cam-01", true, executions, at + 120_000)).toBe(at);
  });

  it("没有执行记录时取首次看到的时刻；离开已处置后清除", () => {
    expect(containedSince("cam-05", true, {}, 1000)).toBe(1000);
    expect(containedSince("cam-05", true, {}, 5000)).toBe(1000);
    expect(containedSince("cam-05", false, {}, 6000)).toBeNull();
    expect(containedSince("cam-05", true, {}, 7000)).toBe(7000);
  });
});

describe("fadeElapsed", () => {
  it("淡出进度按当前时刻计：中途重新挂载接着播放，不从头重播", () => {
    expect(fadeElapsed("cam-07", true, {}, 10_000)).toBe(0);
    expect(fadeElapsed("cam-07", true, {}, 10_600)).toBe(600);
    expect(fadeElapsed("cam-07", false, {}, 11_000)).toBeNull();
  });
});

describe("连线流动（ui.md §5.1）", () => {
  it("dash-flow 每周期前移恰好一个虚线周期，循环处不跳变；朝设备方向流动", () => {
    const offset = /@keyframes dash-flow \{\s*to \{\s*stroke-dashoffset: (-?\d+);/.exec(css)?.[1];
    expect(Number(offset)).toBe(-(DASH[0] + DASH[1]));
  });
});
