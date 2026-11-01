import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { components } from "../../src/api/schema";
import { ApiError, api } from "../../src/lib/api";
import { AiInvestigation, type Investigation } from "../../src/panels/AiInvestigation/AiInvestigation";
import { type Incident, receive, useLive } from "../../src/store/live";

type Frame = components["schemas"]["WsFrame"];

const incident = (changes: Partial<Incident> = {}): Incident => ({
  id: "inc-1",
  rule_id: "HYD-X-0001",
  rule_version: "1.0.0",
  mode: "enforce",
  title: "摄像头疑似被入侵且画面遭篡改",
  severity: "critical",
  device_ids: ["cam-02"],
  source_ip: "172.30.0.100",
  techniques: ["T1110"],
  tactics: ["Credential Access"],
  evidence_refs: [],
  hit_path: [],
  requires_confirmation: true,
  status: "open",
  created_at: "2026-11-08T02:00:00Z",
  ...changes,
});
const STEP = {
  tool: "list_alerts",
  args_summary: "ip=172.30.0.100",
  result_summary: "近 10 分钟 37 条告警",
  reason: "先看攻击源近期的告警",
};
const investigation = (changes: Partial<Investigation> = {}): Investigation => ({
  incident_id: "inc-1",
  steps: [STEP],
  verdict: null,
  error: null,
  provider: { name: "DeepSeek", location: "public" },
  started_at: new Date(Date.now() - 12_000).toISOString(),
  finished_at: null,
  ...changes,
});
const push = (channel: string, data: object) =>
  act(() => receive({ channel, data } as unknown as Frame, Date.now()));

function show() {
  return render(<AiInvestigation deviceId="cam-02" stale={false} />);
}

beforeEach(() => useLive.setState(useLive.getInitialState()));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("AiInvestigation", () => {
  it("所选设备没有关联事件时不渲染", () => {
    push("incidents", incident({ device_ids: ["cam-01"] }));
    show();
    expect(screen.queryByRole("region", { name: "AI 安全值班员" })).toBeNull();
  });

  it("规则结论与 AI 研判分区显示，AI 区注明需人工复核（V-AI1、V-AI2、V-AI8）", async () => {
    vi.spyOn(api, "getInvestigation").mockResolvedValue(investigation());
    push("incidents", incident());
    show();
    const rule = screen.getByRole("region", { name: "规则结论" });
    expect(rule.textContent).toContain("摄像头疑似被入侵且画面遭篡改");
    const ai = screen.getByRole("region", { name: "AI 研判" });
    expect(ai.textContent).toContain("AI 生成 · 需人工复核");
    expect(await screen.findByText("DeepSeek")).toBeTruthy();
    expect(ai.textContent).toContain("公网 · 已脱敏");
  });

  it("步骤显示理由，结果摘要可展开（FR-1102、V-AI6）", async () => {
    vi.spyOn(api, "getInvestigation").mockResolvedValue(investigation());
    push("incidents", incident());
    show();
    expect(await screen.findByText("先看攻击源近期的告警")).toBeTruthy();
    expect(screen.getByText(/近 10 分钟 37 条告警/).closest("details")).toBeTruthy();
    expect(screen.getByText(/调查中 · 已用 1[23] s/)).toBeTruthy();
  });

  it("收到 ai 频道推送即重新读取调查记录（FR-1102）", async () => {
    const get = vi
      .spyOn(api, "getInvestigation")
      .mockRejectedValueOnce(new ApiError(404, "该关联事件尚未开始调查"))
      .mockResolvedValue(investigation());
    push("incidents", incident());
    show();
    expect(await screen.findByText("尚未开始调查")).toBeTruthy();
    push("ai", { incident_id: "inc-1", seq: 0, kind: "step", step: STEP, verdict: null, error: null, provider: null });
    expect(await screen.findByText("先看攻击源近期的告警")).toBeTruthy();
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("调查失败时显示 AI 研判不可用及原因，规则结论照常（FR-1105）", async () => {
    vi.spyOn(api, "getInvestigation").mockResolvedValue(
      investigation({ steps: [], provider: null, error: "未启用任何模型供应商", finished_at: new Date().toISOString() }),
    );
    push("incidents", incident());
    show();
    expect(await screen.findByText("AI 研判不可用：未启用任何模型供应商")).toBeTruthy();
    expect(screen.getByRole("region", { name: "规则结论" }).textContent).toContain("摄像头疑似被入侵");
  });

  it("读取失败时提示，不留空", async () => {
    vi.spyOn(api, "getInvestigation").mockRejectedValue(new Error("HTTP 502"));
    push("incidents", incident());
    show();
    expect(await screen.findByText("无法读取调查记录")).toBeTruthy();
  });
});
