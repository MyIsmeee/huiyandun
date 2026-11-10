import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../src/lib/api";
import { ProgressBar, progressIncident } from "../../src/panels/IncidentTimeline/ProgressBar";
import { type Device, type Incident, useLive } from "../../src/store/live";

const incident = (id: string, device: string) =>
  ({ id, title: `事件 ${id}`, device_ids: [device], hit_path: [], source_ip: "172.30.0.100", created_at: "2026-11-09T02:00:20Z" }) as unknown as Incident;
const device = (id: string, state: Device["state"]) => ({ id, state }) as unknown as Device;

// incidents 新的在前
const INCIDENTS = [incident("inc-3", "cam-03"), incident("inc-2", "cam-02"), incident("inc-1", "cam-01")];

describe("进度条显示的关联事件（设计 150 §3）", () => {
  it("选中设备时为该设备最近一个关联事件，不论是否仍在进行", () => {
    expect(progressIncident(INCIDENTS, "cam-01", [device("cam-01", "normal")])?.id).toBe("inc-1");
  });

  it("未选中或选中的设备没有关联事件时，为最近一个进行中的：所涉设备仍在网络攻击或封禁中", () => {
    const devices = [device("cam-01", "contained"), device("cam-02", "notify_only"), device("cam-03", "normal")];
    expect(progressIncident(INCIDENTS, null, devices)?.id).toBe("inc-2");
    expect(progressIncident(INCIDENTS, "cam-09", devices)?.id).toBe("inc-2");
  });

  it("没有进行中的事件时不显示；物理告警不算网络事件进行中", () => {
    const devices = [device("cam-01", "normal"), device("cam-02", "physical_alert"), device("cam-03", "offline")];
    expect(progressIncident(INCIDENTS, null, devices)).toBeUndefined();
  });
});

describe("ProgressBar", () => {
  beforeEach(() => {
    vi.spyOn(api, "getInvestigation").mockRejectedValue(new Error("404"));
    useLive.setState(useLive.getInitialState());
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("标题与来源、横向五个节点；未到达的节点显示 —", () => {
    render(<ProgressBar incident={incident("inc-bar", "cam-02")} />);
    expect(screen.getByText("事件 inc-bar")).toBeTruthy();
    expect(screen.getByText(/来源 172\.30\.0\.100/)).toBeTruthy();
    const steps = screen.getByRole("region", { name: "处置进度" }).querySelectorAll("li");
    expect([...steps].map((li) => li.querySelector("span.text-sm")?.textContent)).toEqual(["首次告警", "关联事件", "AI 判定", "处置生效", "解除"]);
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(3);
  });
});
