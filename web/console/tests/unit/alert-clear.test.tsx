import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { components } from "../../src/api/schema";
import { api } from "../../src/lib/api";
import { AlertList } from "../../src/panels/AlertList/AlertList";
import { useConnection } from "../../src/store/connection";
import { receive, useLive } from "../../src/store/live";
import { type Role, useSession } from "../../src/store/session";

type Frame = components["schemas"]["WsFrame"];
const frame = (channel: Frame["channel"], data: object) => ({ channel, data }) as unknown as Frame;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const alert = (n: number) => ({
  schema_version: "1.2.0",
  event_id: id(n),
  ts: `2026-11-18T02:00:${String(n).padStart(2, "0")}Z`,
  rule_id: `R-${n}`, // 规则不同：各自一行，不合并
  rule_version: "1",
  mode: "enforce",
  category: "Attempted User Privilege Gain",
  severity: "high",
  src_ip: "172.30.0.100",
  dst_ip: "172.30.0.12",
  device_id: "cam-07",
  technique: "T1110",
  evidence_ref: "suricata:flow/1",
  source: "rule",
  confidence: 1,
  summary: `告警 ${n}`,
});
const incident = {
  id: "inc-1",
  rule_id: "HYD-X-0001",
  rule_version: "1.0.0",
  mode: "enforce",
  title: "摄像头疑似被入侵且画面遭篡改",
  severity: "critical",
  device_ids: ["cam-07"],
  source_ip: "172.30.0.100",
  techniques: ["T1110"],
  tactics: [],
  evidence_refs: [],
  hit_path: [],
  requires_confirmation: false,
  status: "open",
  created_at: "2026-11-18T02:00:30Z",
};
const cleared = (eventIds: string[], incidentIds: string[]) =>
  frame("cleared", { event_ids: eventIds, incident_ids: incidentIds, actor: "operator", ts: "2026-11-18T02:01:00Z" });

function show(role: Role) {
  useSession.setState({ role });
  return render(<AlertList stale={false} lastFrameAt={0} />);
}

beforeEach(() => {
  useLive.setState(useLive.getInitialState());
  useConnection.setState({ synced: true });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("cleared 频道", () => {
  it("移除所列告警与关联事件；之后补推或重复转发的同一条不再列出", () => {
    receive(frame("alerts", alert(1)), 0);
    receive(frame("alerts", alert(2)), 0);
    receive(frame("incidents", incident), 0);

    receive(cleared([id(1)], ["inc-1"]), 0);
    expect(useLive.getState().alerts.map((a) => a.event_id)).toEqual([id(2)]);
    expect(useLive.getState().incidents).toEqual([]);

    // 重连补推：删除记录先到，告警与关联事件后到
    receive(frame("alerts", alert(1)), 0);
    receive(frame("incidents", { ...incident, status: "containing" }), 0);
    expect(useLive.getState().alerts.map((a) => a.event_id)).toEqual([id(2)]);
    expect(useLive.getState().incidents).toEqual([]);
  });
});

describe("删除按钮", () => {
  it("viewer 看不到删除与清空", () => {
    receive(frame("alerts", alert(1)), 0);
    show("viewer");
    expect(screen.queryByRole("button", { name: "删除该告警" })).toBeNull();
    expect(screen.queryByRole("button", { name: /清空/ })).toBeNull();
  });

  it("operator 删除单行告警与关联事件", async () => {
    const clear = vi.spyOn(api, "clearAlerts").mockResolvedValue({ event_ids: [], incident_ids: [], actor: "operator", ts: "" });
    receive(frame("alerts", alert(1)), 0);
    receive(frame("incidents", incident), 0);
    show("operator");

    fireEvent.click(screen.getByRole("button", { name: "删除该告警" }));
    await waitFor(() => expect(clear).toHaveBeenCalledWith([id(1)], []));
    fireEvent.click(screen.getByRole("button", { name: "删除该关联事件" }));
    await waitFor(() => expect(clear).toHaveBeenCalledWith([], ["inc-1"]));
  });

  it("清空：确认后删除当前列出的全部告警与关联事件", async () => {
    const clear = vi.spyOn(api, "clearAlerts").mockResolvedValue({ event_ids: [], incident_ids: [], actor: "operator", ts: "" });
    receive(frame("alerts", alert(1)), 0);
    receive(frame("alerts", alert(2)), 0);
    receive(frame("incidents", incident), 0);
    show("operator");

    fireEvent.click(screen.getByRole("button", { name: /清空/ }));
    expect(screen.getByText(/删除当前列出的 3 条告警/)).toBeTruthy();
    expect(clear).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认清空" }));
    await waitFor(() => expect(clear).toHaveBeenCalledTimes(1));
    const [eventIds, incidentIds] = clear.mock.calls[0] ?? [[], []];
    expect([...eventIds].sort()).toEqual([id(1), id(2)]);
    expect(incidentIds).toEqual(["inc-1"]);
  });
});
