import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { components } from "../../src/api/schema";
import { ApiError, api } from "../../src/lib/api";
import { RESULT_TIMEOUT_MS } from "../../src/panels/ActionBar/ActionBar";
import { AiInvestigation, type Investigation } from "../../src/panels/AiInvestigation/AiInvestigation";
import { type Execution, type Incident, receive, useLive } from "../../src/store/live";
import { type Role, useSession } from "../../src/store/session";

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
const execution = (state: Execution["state"]): Execution => ({
  id: "exe-1",
  playbook_id: "isolate-attacker",
  playbook_version: "1.0.0",
  incident_id: "inc-1",
  device_ids: ["cam-02"],
  target: "172.30.0.100",
  state,
  reason: state === "pending" ? "含模型证据，等待人工确认" : null,
  ttl_s: 150,
  expires_at: null,
  verify_result: null,
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
const VERDICT = {
  is_attack: true,
  confidence: 0.86,
  techniques: ["T1110", "T1565"],
  narrative: "172.30.0.100 对 cam-02 爆破后，10.9.9.9 冻结了画面",
  recommendation: "隔离 10.9.9.9",
  unverified: ["10.9.9.9", "T1565"],
};

const push = (channel: string, data: object) =>
  act(() => receive({ channel, data } as unknown as Frame, Date.now()));

function show(role: Role | null = "operator") {
  useSession.setState({ role });
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
    vi.spyOn(api, "getInvestigation").mockResolvedValue(investigation({ verdict: VERDICT, finished_at: new Date().toISOString() }));
    push("incidents", incident());
    show();
    const rule = screen.getByRole("region", { name: "规则结论" });
    expect(rule.textContent).toContain("摄像头疑似被入侵且画面遭篡改");
    const ai = screen.getByRole("region", { name: "AI 研判" });
    expect(ai.textContent).toContain("AI 生成 · 需人工复核");
    expect(await screen.findByText("判定为攻击")).toBeTruthy();
    expect(ai.textContent).toContain("86%");
    expect(ai.textContent).toContain("DeepSeek");
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

  it("未溯源的实体弱化并说明（FR-1103、V-AI3）", async () => {
    vi.spyOn(api, "getInvestigation").mockResolvedValue(investigation({ verdict: VERDICT, finished_at: new Date().toISOString() }));
    push("incidents", incident());
    show();
    await screen.findByText("判定为攻击");
    const marked = screen.getAllByTitle("该实体未能在证据中溯源").map((e) => e.textContent);
    expect(marked).toEqual(["T1565", "10.9.9.9", "10.9.9.9"]);
    expect(screen.queryAllByTitle("该实体未能在证据中溯源").some((e) => e.textContent === "172.30.0.100")).toBe(false);
  });

  it.each([
    ["viewer", false],
    ["auditor", false],
    [null, false],
    ["operator", true],
    ["admin", true],
  ] as const)("角色 %s：确认处置按钮渲染 %s（C-FE-07、V-AI9）", (role, visible) => {
    vi.spyOn(api, "getInvestigation").mockResolvedValue(investigation());
    push("incidents", incident());
    push("executions", execution("pending"));
    show(role);
    expect(screen.queryByRole("button", { name: /确认处置/ }) !== null).toBe(visible);
  });

  it("按钮文案取自执行的 Playbook 与目标，不取自 AI 文字（V-AI9、G-03）", async () => {
    vi.spyOn(api, "getInvestigation").mockResolvedValue(investigation({ verdict: VERDICT, finished_at: new Date().toISOString() }));
    push("incidents", incident());
    push("executions", execution("pending"));
    show();
    await screen.findByText("判定为攻击");
    expect(screen.getByRole("button", { name: /确认处置/ }).textContent).toBe("确认处置：isolate-attacker 封禁 172.30.0.100");
  });

  it.each([
    ["无需确认", incident({ requires_confirmation: false }), execution("pending")],
    ["已在执行", incident(), execution("executing")],
    ["尚无执行", incident(), null],
  ])("%s时不渲染确认按钮", (_, i, e) => {
    vi.spyOn(api, "getInvestigation").mockResolvedValue(investigation());
    push("incidents", i);
    if (e) push("executions", e);
    show();
    expect(screen.queryByRole("button", { name: /确认处置/ })).toBeNull();
  });

  it("确认后不可再点，执行器开始执行后按钮消失（FR-407）", async () => {
    vi.spyOn(api, "getInvestigation").mockResolvedValue(investigation());
    const confirm = vi.spyOn(api, "confirmContainment").mockResolvedValue(undefined);
    push("incidents", incident());
    push("executions", execution("pending"));
    show();
    fireEvent.click(screen.getByRole("button", { name: /确认处置/ }));
    expect(confirm).toHaveBeenCalledWith("inc-1");
    await waitFor(() => expect(screen.getByRole("button", { name: "确认中…" }).hasAttribute("disabled")).toBe(true));
    push("executions", execution("executing"));
    expect(screen.queryByRole("button", { name: /确认/ })).toBeNull();
  });

  it("受理后超时未收到执行结果：恢复可点并提示", async () => {
    vi.useFakeTimers();
    vi.spyOn(api, "getInvestigation").mockResolvedValue(investigation());
    vi.spyOn(api, "confirmContainment").mockResolvedValue(undefined);
    push("incidents", incident());
    push("executions", execution("pending"));
    show();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /确认处置/ })));
    act(() => vi.advanceTimersByTime(RESULT_TIMEOUT_MS));
    expect(screen.getByRole("alert").textContent).toContain("未收到执行结果，请重试");
    expect(screen.getByRole("button", { name: /确认处置/ }).hasAttribute("disabled")).toBe(false);
  });

  it("确认被拒时显示原因并可重试", async () => {
    vi.spyOn(api, "getInvestigation").mockResolvedValue(investigation());
    vi.spyOn(api, "confirmContainment").mockRejectedValue(new ApiError(503, "处置执行器暂不可达，请稍后重试"));
    push("incidents", incident());
    push("executions", execution("pending"));
    show();
    fireEvent.click(screen.getByRole("button", { name: /确认处置/ }));
    expect((await screen.findByRole("alert")).textContent).toContain("处置执行器暂不可达");
    expect(screen.getByRole("button", { name: /确认处置/ }).hasAttribute("disabled")).toBe(false);
  });
});
