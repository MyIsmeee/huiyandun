import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { components } from "../../src/api/schema";
import { api } from "../../src/lib/api";
import {
  awaitingInvestigation,
  formatOffset,
  IncidentTimeline,
  readInvestigation,
  TimelineDots,
  timelineOf,
} from "../../src/panels/IncidentTimeline/IncidentTimeline";
import { useConnection } from "../../src/store/connection";
import { type Alert, type Execution, type Incident, MAX_INCIDENTS, receive, useLive } from "../../src/store/live";

const HIT = "00000000-0000-4000-8000-000000000001";
const incident = {
  id: "inc-1",
  rule_id: "HYD-X-0001",
  rule_version: "1.0.0",
  mode: "enforce",
  title: "摄像头疑似被入侵且画面遭篡改",
  severity: "critical",
  device_ids: ["cam-02"],
  source_ip: "172.30.0.100",
  techniques: ["T1110"],
  tactics: [],
  evidence_refs: [],
  hit_path: [HIT, "00000000-0000-4000-8000-000000000002"],
  requires_confirmation: false,
  status: "open",
  created_at: "2026-11-08T02:00:20Z",
} as unknown as Incident;
const alerts = [
  { event_id: HIT, ts: "2026-11-08T02:00:05Z" },
  { event_id: "other", ts: "2026-11-08T01:59:00Z" },
] as unknown as Alert[];
const execution = (state: Execution["state"]) => ({ id: "exe-1", incident_id: "inc-1", state }) as unknown as Execution;
const verdict = {
  incident_id: "inc-1",
  steps: [],
  verdict: { is_attack: true, confidence: 0.92, techniques: [], narrative: "", recommendation: "", unverified: [] },
  error: null,
  provider: null,
  started_at: "2026-11-08T02:00:21Z",
  finished_at: "2026-11-08T02:00:50Z",
};

describe("处置时间线（FR-304、D-106）", () => {
  it("各节点取系统事件时刻：首次告警为命中路径中最早的告警", () => {
    const times = { contained: "2026-11-08T02:00:31Z", rolled_back: "2026-11-08T02:30:31Z" };
    const nodes = timelineOf(incident, alerts, execution("rolled_back"), times, verdict);
    expect(nodes.map((n) => [n.key, n.reached, n.at && new Date(n.at).toISOString(), n.note])).toEqual([
      ["first", true, "2026-11-08T02:00:05.000Z", null],
      ["incident", true, "2026-11-08T02:00:20.000Z", null],
      ["ai", true, "2026-11-08T02:00:50.000Z", "判定为攻击 · 92%"],
      ["contained", true, "2026-11-08T02:00:31.000Z", null],
      ["released", true, "2026-11-08T02:30:31.000Z", null],
    ]);
  });

  it("未到达的节点如实说明：待确认、调查中、命中告警已超出保留", () => {
    const nodes = timelineOf(incident, [], execution("pending"), {}, { ...verdict, verdict: null, finished_at: null });
    expect(nodes.map((n) => [n.key, n.reached, n.note])).toEqual([
      ["first", false, "已超出保留"],
      ["incident", true, null],
      ["ai", false, "调查中"],
      ["contained", false, "待确认"],
      ["released", false, "封禁中或未处置"],
    ]);
  });

  it("刷新后只补推最新状态：已解除但生效时刻未知；无执行为未处置；AI 失败为不可用", () => {
    const failed = { ...verdict, verdict: null, error: "无可用供应商" };
    expect(timelineOf(incident, alerts, execution("rolled_back"), {}, failed).slice(2, 4)).toEqual([
      expect.objectContaining({ key: "ai", reached: true, note: "AI 研判不可用" }),
      expect.objectContaining({ key: "contained", reached: true, at: null, note: "时刻未知" }),
    ]);
    expect(timelineOf(incident, alerts, undefined, {}, null).slice(2, 4)).toEqual([
      expect.objectContaining({ note: "未调查" }),
      expect.objectContaining({ reached: false, note: "未处置" }),
    ]);
  });

  it("处置生效时刻取 expires_at − ttl_s：之后的补注推送与刷新后的补推都不改变它", () => {
    const contained = { ...execution("contained"), ttl_s: 1800, expires_at: "2026-11-08T02:30:31Z" } as Execution;
    // 推送记下的是补注时刻（晚于生效），以执行本身推出的为准
    const nodes = timelineOf(incident, alerts, contained, { contained: "2026-11-08T02:00:59Z" }, verdict);
    expect(new Date(nodes[3]?.at ?? 0).toISOString()).toBe("2026-11-08T02:00:31.000Z");
    const released = { ...contained, state: "rolled_back" } as Execution;
    expect(new Date(timelineOf(incident, alerts, released, {}, verdict)[3]?.at ?? 0).toISOString()).toBe("2026-11-08T02:00:31.000Z");
  });

  it("物理域事件（HYD-VIS-*）：画面事件不进告警栏，首次告警取生成时刻；处置与解除写明不涉及封禁", () => {
    const occluded = { ...incident, rule_id: "HYD-VIS-0001", source_ip: null, hit_path: ["frame-event"] } as Incident;
    const nodes = timelineOf(occluded, alerts, undefined, {}, null);
    expect(nodes.map((n) => [n.key, n.reached, n.note])).toEqual([
      ["first", true, null],
      ["incident", true, null],
      ["ai", false, "未调查"],
      ["contained", false, "不涉及封禁"],
      ["released", false, "不涉及封禁"],
    ]);
    expect(nodes[0]?.at).toBe(Date.parse(occluded.created_at));
  });

  it("尚无调查记录但仍在等待调查时说明等待调查", () => {
    expect(timelineOf(incident, alerts, undefined, {}, null, true)[2]).toEqual(expect.objectContaining({ note: "等待调查" }));
    const created = Date.parse(incident.created_at);
    expect(awaitingInvestigation(incident, created + 60_000)).toBe(true);
    expect(awaitingInvestigation(incident, created + 60 * 60_000)).toBe(false);
    expect(awaitingInvestigation({ ...incident, severity: "medium" }, created + 60_000)).toBe(false);
  });
});

describe("执行状态时刻", () => {
  beforeEach(() => useLive.setState(useLive.getInitialState()));
  it("同一状态只记首次的事件时刻", () => {
    const push = (ts: string) =>
      receive({ channel: "executions", data: { ...execution("contained"), ts } } as unknown as components["schemas"]["WsFrame"], 0);
    push("2026-11-08T02:00:31Z");
    push("2026-11-08T02:00:59Z");
    expect(useLive.getState().executionTimes["exe-1"]?.contained).toBe("2026-11-08T02:00:31Z");
  });
});

describe("formatOffset（ui.md §4 时长格式）", () => {
  it("小于 1 分钟按秒，小于 1 小时按分秒，否则按时分", () => {
    expect(formatOffset(0)).toBe("+0 秒");
    expect(formatOffset(38_800)).toBe("+39 秒");
    expect(formatOffset(1_800_100)).toBe("+30 分 0 秒");
    expect(formatOffset(3_725_000)).toBe("+1 小时 2 分");
  });
});

describe("调查记录的读取", () => {
  type Frame = components["schemas"]["WsFrame"];
  const ai = (seq: number, kind: "step" | "verdict") =>
    ({ channel: "ai", data: { incident_id: "inc-reads", seq, kind } }) as unknown as Frame;

  beforeEach(() => useLive.setState(useLive.getInitialState()));
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("进度点与抽屉时间线共用一次读取；中间步骤不重读，调查开始与结束各重读一次", async () => {
    const own = { ...incident, id: "inc-reads" } as Incident;
    const read = vi.spyOn(api, "getInvestigation").mockResolvedValue({ ...verdict, incident_id: "inc-reads" });
    useLive.setState({ incidents: [own] });
    render(
      <>
        <TimelineDots incident={own} />
        <TimelineDots incident={own} />
        <IncidentTimeline />
      </>,
    );
    expect(await screen.findAllByRole("img", { name: "处置进度 2/5：AI 判定" })).toHaveLength(2);
    expect(read).toHaveBeenCalledTimes(1);

    act(() => receive(ai(0, "step"), 0));
    act(() => receive(ai(1, "step"), 0));
    act(() => receive(ai(2, "verdict"), 0));
    await act(async () => undefined);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("重连（epoch 变化）后重读未结束的调查；已结束的记录不再重读", async () => {
    const running = { ...verdict, verdict: null, finished_at: null, incident_id: "inc-epoch" };
    const read = vi.spyOn(api, "getInvestigation").mockResolvedValueOnce(running).mockResolvedValue({ ...verdict, incident_id: "inc-epoch" });
    await readInvestigation("inc-epoch", "unknown", 100);
    await readInvestigation("inc-epoch", "unknown", 100);
    expect(read).toHaveBeenCalledTimes(1);
    await readInvestigation("inc-epoch", "unknown", 101);
    expect(read).toHaveBeenCalledTimes(2);
    await readInvestigation("inc-epoch", "unknown", 102); // 已结束
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("时间线在重连后重新读取调查记录", async () => {
    const own = { ...incident, id: "inc-reconnect" } as Incident;
    const read = vi.spyOn(api, "getInvestigation").mockResolvedValue({ ...verdict, finished_at: null, verdict: null, incident_id: "inc-reconnect" });
    useLive.setState({ incidents: [own] });
    render(<TimelineDots incident={own} />);
    await act(async () => undefined);
    expect(read).toHaveBeenCalledTimes(1);
    act(() => useConnection.setState((s) => ({ epoch: s.epoch + 1 })));
    await act(async () => undefined);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("缓存只保留最近读取的 MAX_INCIDENTS 个事件", async () => {
    const read = vi.spyOn(api, "getInvestigation").mockResolvedValue(verdict);
    for (let i = 0; i <= MAX_INCIDENTS; i += 1) await readInvestigation(`inc-cap-${i}`, "unknown");
    expect(read).toHaveBeenCalledTimes(MAX_INCIDENTS + 1);

    await readInvestigation(`inc-cap-${MAX_INCIDENTS}`, "unknown"); // 仍在缓存中
    expect(read).toHaveBeenCalledTimes(MAX_INCIDENTS + 1);
    await readInvestigation("inc-cap-0", "unknown"); // 最早的已淘汰，重新读取
    expect(read).toHaveBeenCalledTimes(MAX_INCIDENTS + 2);
  });
});
