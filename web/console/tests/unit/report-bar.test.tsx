import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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
  investigation: null,
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

const page = () => screen.queryByRole("heading", { level: 1 });
const frame = () => screen.getByTitle("报告内容");

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
  ] as const)("角色 %s：历史报告都可看，生成按钮 %s（C-FE-07）", async (role, visible) => {
    push(incident("inc-1"));
    vi.spyOn(api, "listReports").mockResolvedValue({ items: [] });
    show(role);
    await act(async () => {});
    expect(screen.getByText("尚无报告")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "生成报告" }) !== null).toBe(visible);
  });

  it("列出最近关联事件的历史报告，点击打开报告页（TK-071）", async () => {
    push(incident("inc-1"));
    push(incident("inc-2"));
    const list = vi.spyOn(api, "listReports").mockResolvedValue({
      items: [report({ id: "rep-2", source: "llm", reviewed_by: "admin" }), report()],
    });
    show("viewer");
    await act(async () => {});

    expect(list).toHaveBeenCalledWith("inc-2");
    const [newest, older] = within(screen.getByRole("list", { name: "历史报告" })).getAllByRole("button");
    expect([newest, older].map((r) => r?.textContent?.split(" · ").slice(1).join(" · "))).toEqual([
      "模型生成 · 已复核",
      "模板生成 · 未复核",
    ]);
    expect(newest?.getAttribute("title")).toBe("模型生成 · 已复核：admin");
    fireEvent.click(older as HTMLElement);

    expect(page()?.textContent).toBe("溯源报告：摄像头疑似被入侵且画面遭篡改 inc-1");
    expect(frame().getAttribute("src")).toBe("/api/reports/rep-1/export?format=html");
    expect(frame().getAttribute("sandbox")).toBe("");
    expect(screen.getByRole("link", { name: "下载 Markdown" }).getAttribute("href")).toBe(
      "/api/reports/rep-1/export?format=md",
    );
    expect(screen.queryByRole("button", { name: "标记已复核" })).toBeNull(); // viewer
    fireEvent.click(screen.getByRole("button", { name: "返回" }));
    expect(page()).toBeNull();
  });

  it("历史报告读取失败时提示，仍可生成", async () => {
    push(incident("inc-1"));
    vi.spyOn(api, "listReports").mockRejectedValue(new Error("HTTP 502"));
    show("operator");
    await act(async () => {});
    expect(screen.getByText("历史报告读取失败")).toBeTruthy();
    expect(screen.getByRole("button", { name: "生成报告" })).toBeTruthy();
  });

  it("生成后新报告置顶并直接打开报告页", async () => {
    push(incident("inc-1"));
    vi.spyOn(api, "listReports").mockResolvedValue({ items: [report()] });
    const create = vi.spyOn(api, "createReport").mockResolvedValue(report({ id: "rep-new" }));
    show("operator");
    await act(async () => {});

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "生成报告" })));

    expect(create).toHaveBeenCalledWith("inc-1");
    expect(frame().getAttribute("src")).toBe("/api/reports/rep-new/export?format=html");
    expect(within(screen.getByRole("list", { name: "历史报告" })).getAllByRole("button")).toHaveLength(2);
  });

  it("在报告页标记已复核后两处同时更新，网页重新加载（FR-504、V-AI4）", async () => {
    push(incident("inc-1"));
    vi.spyOn(api, "listReports").mockResolvedValue({ items: [report()] });
    const reviewed = report({ reviewed_by: "operator", reviewed_at: "2026-11-08T02:05:00Z" });
    const review = vi.spyOn(api, "reviewReport").mockResolvedValue(reviewed);
    show("operator");
    await act(async () => {});
    fireEvent.click(within(screen.getByRole("list", { name: "历史报告" })).getByRole("button"));
    const before = frame();

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "标记已复核" })));

    expect(review).toHaveBeenCalledWith("rep-1");
    expect(screen.queryByRole("button", { name: "标记已复核" })).toBeNull();
    expect(screen.getByText("模板生成 · 已复核：operator")).toBeTruthy(); // 报告页
    expect(screen.getByTitle("模板生成 · 已复核：operator")).toBeTruthy(); // 历史行
    expect(frame()).not.toBe(before);
  });

  it("请求期间不可再点，失败显示原因并可重试", async () => {
    push(incident("inc-1"));
    vi.spyOn(api, "listReports").mockResolvedValue({ items: [] });
    let reject: (e: Error) => void = () => {};
    vi.spyOn(api, "createReport").mockReturnValue(new Promise((_, r) => (reject = r)));
    show("operator");
    await act(async () => {});

    fireEvent.click(screen.getByRole("button", { name: "生成报告" }));
    expect(screen.getByRole("button", { name: "生成中…" }).hasAttribute("disabled")).toBe(true);
    await act(async () => reject(new ApiError(404, "关联事件不存在或已超过 24 小时")));

    expect(screen.getByRole("alert").textContent).toBe("关联事件不存在或已超过 24 小时");
    expect(screen.getByRole("button", { name: "生成报告" }).hasAttribute("disabled")).toBe(false);
  });
});
