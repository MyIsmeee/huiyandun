import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { components } from "../../src/api/schema";
import { AlertList } from "../../src/panels/AlertList/AlertList";
import { MAX_ALERTS, receive, useLive } from "../../src/store/live";
import { useSelection } from "../../src/store/selection";

type Frame = components["schemas"]["WsFrame"];
const frame = (channel: Frame["channel"], data: object) => ({ channel, data }) as unknown as Frame;
const base = (n: number) => ({
  schema_version: "1.2.0",
  event_id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  ts: `2026-11-08T02:00:${String(n).padStart(2, "0")}Z`,
});

const alert = (n: number, source: "rule" | "model" = "rule") => ({
  ...base(n),
  rule_id: "HYD-NET-0001",
  rule_version: "3",
  mode: "enforce",
  category: "auth_bruteforce",
  severity: "high",
  src_ip: "172.30.0.100",
  dst_ip: "172.30.0.12",
  device_id: "cam-02",
  technique: "T1110",
  evidence_ref: "suricata:flow/1",
  source,
  confidence: source === "rule" ? 1 : 0.82,
  summary: `告警 ${n}`,
});
const fall = (n: number) => ({
  ...base(n),
  camera_id: "cam-01",
  track_id: 3,
  behavior: "fall",
  confidence_avg: 0.9,
  duration_s: 2,
  ts_start: base(n).ts,
  ts_end: base(n).ts,
});
const incident = {
  id: "inc-1",
  rule_id: "HYD-X-0001",
  rule_version: "1.0.0",
  mode: "enforce",
  title: "摄像头疑似被入侵且画面遭篡改",
  severity: "critical",
  device_ids: ["cam-02"],
  source_ip: "172.30.0.100",
  techniques: ["T1110", "T0832"],
  tactics: ["Credential Access", "Impact"],
  evidence_refs: [],
  hit_path: [],
  requires_confirmation: false,
  status: "open",
  created_at: "2026-11-08T02:00:30Z",
};
const execution = (state: string) => ({
  id: "exe-1",
  playbook_id: "isolate-attacker",
  playbook_version: "1.0.0",
  incident_id: "inc-1",
  device_ids: ["cam-02"],
  target: "172.30.0.100",
  state,
  reason: null,
  ttl_s: 150,
  expires_at: null,
  verify_result: null,
});

beforeEach(() => {
  useLive.setState(useLive.getInitialState());
  useSelection.setState(useSelection.getInitialState());
});
afterEach(cleanup);

describe("告警的接收", () => {
  it("新的在前，按 event_id 去重（连接补推与实时转发可能重复），保留上限", () => {
    receive(frame("alerts", alert(1)), 0);
    receive(frame("alerts", alert(3)), 0);
    receive(frame("alerts", alert(2)), 0);
    receive(frame("alerts", alert(3)), 0);
    expect(useLive.getState().alerts.map((a) => a.ts.slice(-3))).toEqual(["03Z", "02Z", "01Z"]);

    for (let n = 4; n < MAX_ALERTS + 10; n++) receive(frame("alerts", alert(n % 60)), 0);
    expect(useLive.getState().alerts.length).toBeLessThanOrEqual(MAX_ALERTS);
  });

  it("关联事件按 id 更新，执行状态按 id 保留最新", () => {
    receive(frame("incidents", incident), 0);
    receive(frame("incidents", { ...incident, status: "containing" }), 0);
    receive(frame("executions", execution("executing")), 0);
    receive(frame("executions", execution("contained")), 0);

    const { incidents, executions } = useLive.getState();
    expect(incidents.map((i) => i.status)).toEqual(["containing"]);
    expect(executions["exe-1"]?.state).toBe("contained");
  });
});

describe("AlertList", () => {
  it("无告警时显示空态与最后更新时间", () => {
    render(<AlertList stale={false} lastFrameAt={null} />);
    expect(screen.getByText("暂无告警")).toBeTruthy();
  });

  it("断线时保留断开前的告警并标注数据非实时（UP-3、V-U3）", () => {
    receive(frame("alerts", alert(1)), 0);
    render(<AlertList stale lastFrameAt={0} />);
    expect(screen.getByText(/数据非实时/)).toBeTruthy();
    expect(screen.getByText("告警 1")).toBeTruthy();
  });

  it("关联事件置顶并显示处置状态（D-077）", () => {
    receive(frame("alerts", alert(1)), 0);
    receive(frame("incidents", incident), 0);
    receive(frame("executions", execution("contained")), 0);
    render(<AlertList stale={false} lastFrameAt={0} />);

    const pinned = screen.getByRole("list", { name: "关联事件" });
    expect(within(pinned).getByText("摄像头疑似被入侵且画面遭篡改")).toBeTruthy();
    expect(within(pinned).getByText("已处置")).toBeTruthy();
    expect(within(pinned).getByText(/严重 · cam-02/)).toBeTruthy();
  });

  it("规则来源为盾牌、模型来源为芯片并显示可信度；行为事件按模型证据显示（V-AI10、D-069）", () => {
    receive(frame("alerts", alert(1, "rule")), 0);
    receive(frame("alerts", alert(2, "model")), 0);
    receive(frame("alerts", fall(3)), 0);
    render(<AlertList stale={false} lastFrameAt={0} />);

    const items = within(screen.getByRole("list", { name: "单条告警" })).getAllByRole("listitem");
    const item = (i: number) => {
      const el = items[i];
      if (!el) throw new Error(`缺少第 ${i} 条`);
      return el;
    };
    expect(items.map((li) => li.textContent)).toEqual([
      expect.stringContaining("跌倒"),
      expect.stringContaining("告警 2"),
      expect.stringContaining("告警 1"),
    ]);
    expect(within(item(0)).getByLabelText("模型")).toBeTruthy();
    expect(item(0).textContent).toContain("90%");
    expect(within(item(1)).getByLabelText("模型")).toBeTruthy();
    expect(item(1).textContent).toContain("82%");
    expect(within(item(2)).getByLabelText("规则")).toBeTruthy();
    expect(item(2).textContent).not.toContain("%");
  });

  it("单击选中对应设备，选中设备的条目高亮（V-I3）", () => {
    receive(frame("alerts", alert(1)), 0);
    receive(frame("alerts", fall(2)), 0);
    render(<AlertList stale={false} lastFrameAt={0} />);

    fireEvent.click(screen.getByText("告警 1"));
    expect(useSelection.getState().deviceId).toBe("cam-02");
    const current = screen.getAllByRole("button").filter((b) => b.getAttribute("aria-current"));
    expect(current.map((b) => b.textContent)).toEqual([expect.stringContaining("告警 1")]);
  });
});
