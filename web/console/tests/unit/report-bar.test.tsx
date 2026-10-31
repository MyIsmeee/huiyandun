import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { components } from "../../src/api/schema";
import { ApiError, api } from "../../src/lib/api";
import { type Report, ReportBar } from "../../src/panels/ReportBar/ReportBar";
import { receive, useLive } from "../../src/store/live";
import { type Role, useSession } from "../../src/store/session";

type Frame = components["schemas"]["WsFrame"];
type Incident = components["schemas"]["incident.schema"];

const incident = (id: string, device = "cam-02"): Incident => ({
  id,
  rule_id: "HYD-X-0001",
  rule_version: "1.0.0",
  mode: "enforce",
  title: `摄像头疑似被入侵且画面遭篡改 ${id}`,
  severity: "critical",
  device_ids: [device],
  source_ip: "172.30.0.100",
  techniques: ["T1110"],
  tactics: ["Credential Access"],
  evidence_refs: [],
  hit_path: [],
  requires_confirmation: false,
  status: "open",
  created_at: "2026-11-08T02:00:00Z",
});
const report = (changes: Partial<Report> = {}): Report => ({
  id: "rep-1",
  incident_id: "inc-1",
  facts: { incident: incident("inc-1"), devices: [], timeline: [], executions: [] },
  ai: null,
  source: "template",
  provider_id: null,
  degraded_reason: "未启用任何模型供应商",
  reviewed_by: null,
  reviewed_at: null,
  created_at: "2026-11-08T02:01:00Z",
  ...changes,
});
const push = (i: Incident) => act(() => receive({ channel: "incidents", data: i } as unknown as Frame, Date.now()));

function show(role: Role | null) {
  useSession.setState({ role });
  return render(<ReportBar deviceId="cam-02" />);
}

beforeEach(() => useLive.setState(useLive.getInitialState()));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ReportBar", () => {
  it("所选设备没有关联事件时不渲染", () => {
    push(incident("inc-9", "cam-01"));
    show("operator");
    expect(screen.queryByRole("region", { name: "报告" })).toBeNull();
  });

  it.each([
    ["viewer", false],
    ["auditor", false],
    [null, false],
    ["operator", true],
    ["admin", true],
  ] as const)("角色 %s：渲染 %s（C-FE-07）", (role, visible) => {
    push(incident("inc-1"));
    show(role);
    expect(screen.queryByRole("button", { name: "生成报告" }) !== null).toBe(visible);
  });

  it("对最近的关联事件生成报告，之后可查看网页、下载 Markdown（D-078）", async () => {
    push(incident("inc-1"));
    push(incident("inc-2"));
    const create = vi.spyOn(api, "createReport").mockResolvedValue(report());
    show("operator");

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "生成报告" })));

    expect(create).toHaveBeenCalledWith("inc-2");
    expect(screen.getByText("模板生成 · 未复核草稿")).toBeTruthy();
    const view = screen.getByRole("link", { name: "查看报告" });
    expect(view.getAttribute("href")).toBe("/api/reports/rep-1/export?format=html");
    expect(view.getAttribute("target")).toBe("_blank");
    expect(screen.getByRole("link", { name: "下载 Markdown" }).getAttribute("href")).toBe(
      "/api/reports/rep-1/export?format=md",
    );
  });

  it("标记已复核后显示复核人，按钮消失（FR-504）", async () => {
    push(incident("inc-1"));
    vi.spyOn(api, "createReport").mockResolvedValue(report());
    const review = vi.spyOn(api, "reviewReport").mockResolvedValue(report({ reviewed_by: "operator" }));
    show("operator");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "生成报告" })));

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "标记已复核" })));

    expect(review).toHaveBeenCalledWith("rep-1");
    expect(screen.getByText("模板生成 · 已复核：operator")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "标记已复核" })).toBeNull();
  });

  it("请求期间不可再点，失败显示原因并可重试", async () => {
    push(incident("inc-1"));
    let reject: (e: Error) => void = () => {};
    vi.spyOn(api, "createReport").mockReturnValue(new Promise((_, r) => (reject = r)));
    show("operator");

    fireEvent.click(screen.getByRole("button", { name: "生成报告" }));
    expect(screen.getByRole("button", { name: "生成中…" }).hasAttribute("disabled")).toBe(true);
    await act(async () => reject(new ApiError(404, "关联事件不存在或已超过 24 小时")));

    expect(screen.getByRole("alert").textContent).toBe("关联事件不存在或已超过 24 小时");
    expect(screen.getByRole("button", { name: "生成报告" }).hasAttribute("disabled")).toBe(false);
  });
});
