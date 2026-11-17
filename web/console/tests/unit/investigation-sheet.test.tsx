import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Investigation } from "../../src/panels/AiInvestigation/AiInvestigation";
import { InvestigationSheetView, InvestigationWatcher } from "../../src/panels/InvestigationSheet/InvestigationSheet";
import { AUTO_OPEN_MS, autoOpenTarget, useSheet } from "../../src/panels/InvestigationSheet/sheet";
import { type Execution, type Incident, useLive } from "../../src/store/live";

const NOW = Date.parse("2026-11-18T02:00:00Z");
const incident = (id: string, changes: Partial<Incident> = {}): Incident => ({
  id,
  rule_id: "HYD-X-0001",
  rule_version: "1.0.0",
  mode: "enforce",
  title: "摄像头疑似被入侵且画面遭篡改",
  severity: "critical",
  device_ids: ["cam-07"],
  source_ip: "172.30.0.100",
  techniques: ["T1110", "T0832"],
  tactics: ["Credential Access"],
  evidence_refs: [],
  hit_path: [],
  requires_confirmation: true,
  status: "open",
  created_at: new Date(NOW - 5_000).toISOString(),
  ...changes,
});
const execution = (state: Execution["state"]): Execution => ({
  id: "exe-1",
  playbook_id: "isolate-attacker",
  playbook_version: "1.2.0",
  incident_id: "inc-x",
  device_ids: ["cam-07"],
  target: "172.30.0.100",
  state,
  reason: null,
  ttl_s: 1800,
  expires_at: null,
  verify_result: null,
});
const STEPS = [
  { tool: "get_device", reason: "先核实被攻击摄像头的登记信息", args_summary: "device_id=cam-07", result_summary: "cam-07：camera 172.30.0.12" },
  { tool: "query_sessions", reason: "查攻击源的网络会话", args_summary: "ip=172.30.0.100, minutes=30", result_summary: "近 30 分钟 17 个会话" },
];
const investigation = (changes: Partial<Investigation> = {}): Investigation => ({
  incident_id: "inc-x",
  steps: STEPS,
  verdict: null,
  error: null,
  provider: { name: "DeepSeek", location: "public" },
  started_at: new Date(NOW - 12_000).toISOString(),
  finished_at: null,
  ...changes,
});

function view(props: { execution?: Execution; load?: Parameters<typeof InvestigationSheetView>[0]["load"] }) {
  return render(
    <InvestigationSheetView
      incident={incident("inc-x")}
      execution={props.execution}
      load={props.load ?? { status: "ready", investigation: investigation() }}
      now={NOW}
      stale={false}
      onClose={() => undefined}
    />,
  );
}

afterEach(cleanup);

describe("自动打开", () => {
  it("只对新到达、刚生成、调查范围内的事件；同时到达时取最新", () => {
    const seen = new Set(["old"]);
    const incidents = [
      incident("newest"),
      incident("medium", { severity: "medium" }),
      incident("stale", { created_at: new Date(NOW - AUTO_OPEN_MS - 1).toISOString() }),
      incident("older"),
      incident("old"),
    ];
    expect(autoOpenTarget(incidents, seen, NOW)).toBe("newest");
    expect(autoOpenTarget(incidents, seen, NOW)).toBeNull(); // 都已处理过
  });

  describe("InvestigationWatcher", () => {
    beforeEach(() => {
      useSheet.setState({ incidentId: null });
      useLive.setState({ incidents: [] });
    });

    it("登录时已有的事件不弹出，之后实时到达的高危事件打开研判面板", () => {
      useLive.setState({ incidents: [incident("before", { created_at: new Date().toISOString() })] });
      render(<InvestigationWatcher />);
      expect(useSheet.getState().incidentId).toBeNull();

      act(() => useLive.setState((s) => ({ incidents: [incident("live", { created_at: new Date().toISOString() }), ...s.incidents] })));
      expect(useSheet.getState().incidentId).toBe("live");
    });
  });
});

describe("研判面板", () => {
  it("每一步完整列出目的、查询与结果，进行中时提示下一步", () => {
    view({ execution: execution("contained") });
    const steps = screen.getByRole("list", { name: "调查步骤" });
    expect(within(steps).getByText("第 1 步 · 查询设备档案")).toBeTruthy();
    expect(within(steps).getByText("第 2 步 · 查询网络会话")).toBeTruthy();
    expect(within(steps).getByText("ip=172.30.0.100, minutes=30")).toBeTruthy();
    expect(within(steps).getByText("近 30 分钟 17 个会话")).toBeTruthy();
    expect(within(steps).getByText(/第 3 步：正在选择下一项查询/)).toBeTruthy();
  });

  it("流程条：规则命中 → 规则剧本封禁 → AI 调查进度 → 结论", () => {
    view({ execution: execution("contained") });
    const flow = screen.getByRole("list", { name: "处理流程" });
    expect(within(flow).getByText(/HYD-X-0001/)).toBeTruthy();
    expect(within(flow).getByText("已封禁 172.30.0.100")).toBeTruthy();
    expect(within(flow).getByText("第 3 步 · 已用 12 s")).toBeTruthy();
    expect(within(flow).getByText("尚无结论")).toBeTruthy();
  });

  it("待人工确认的处置与结论", () => {
    const verdict = {
      is_attack: true,
      confidence: 0.78,
      techniques: ["T1110"],
      narrative: "172.30.0.100 对 cam-07 认证爆破",
      recommendation: "保持封禁并轮换口令",
      unverified: [],
    };
    view({
      execution: execution("pending"),
      load: { status: "ready", investigation: investigation({ verdict, finished_at: new Date(NOW - 2_000).toISOString() }) },
    });
    const flow = screen.getByRole("list", { name: "处理流程" });
    expect(within(flow).getByText("待人工确认：封禁 172.30.0.100")).toBeTruthy();
    expect(within(flow).getByText("2 步 · 用时 10 s")).toBeTruthy();
    expect(within(flow).getByText("判定为攻击 · 78%")).toBeTruthy();
    expect(screen.getByRole("region", { name: "调查结论" }).textContent).toContain("保持封禁并轮换口令");
    expect(screen.queryByText(/正在选择下一项查询/)).toBeNull();
  });

  it("模型不可用时说明原因", () => {
    view({ load: { status: "ready", investigation: investigation({ steps: [], error: "未启用任何模型供应商", finished_at: new Date(NOW).toISOString() }) } });
    expect(screen.getByText("AI 调查不可用：未启用任何模型供应商")).toBeTruthy();
    expect(within(screen.getByRole("list", { name: "处理流程" })).getByText("不可用：未启用任何模型供应商")).toBeTruthy();
  });
});
