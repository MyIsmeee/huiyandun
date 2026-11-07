import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { components } from "../../src/api/schema";
import { api } from "../../src/lib/api";
import { formatOffset, IncidentTimeline, TimelineDots, timelineOf } from "../../src/panels/IncidentTimeline/IncidentTimeline";
import { type Alert, type Execution, type Incident, receive, useLive } from "../../src/store/live";

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
});

describe("formatOffset（04 §4.1 时长格式）", () => {
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
});
