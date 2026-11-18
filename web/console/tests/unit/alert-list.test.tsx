import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { components } from "../../src/api/schema";
import { AlertList, alertText as describeAlert, groupAlerts } from "../../src/panels/AlertList/AlertList";
import { useConnection } from "../../src/store/connection";
import { MAX_ALERTS, receive, useLive } from "../../src/store/live";
import { select, useSelection } from "../../src/store/selection";

type Frame = components["schemas"]["WsFrame"];
const frame = (channel: Frame["channel"], data: object) => ({ channel, data }) as unknown as Frame;
const base = (n: number) => ({
  schema_version: "1.2.0",
  event_id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  ts: `2026-11-08T02:00:${String(n).padStart(2, "0")}Z`,
});

const alert = (n: number, source: "rule" | "model" = "rule") => ({
  ...base(n),
  // 外部规则的分类不在中文标题表里，标题照原文显示：各条告警按 summary 中的编号区分
  rule_id: "ET-2000001",
  rule_version: "3",
  mode: "enforce",
  category: "Attempted User Privilege Gain",
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
  useConnection.setState({ synced: true });
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

  it("收到首帧前为载入中，不显示暂无告警；首次连接失败时说明未能载入", () => {
    useConnection.setState({ synced: false });
    const { rerender } = render(<AlertList stale={false} lastFrameAt={null} />);
    expect(screen.getByText("正在载入告警…")).toBeTruthy();
    rerender(<AlertList stale lastFrameAt={null} />);
    expect(screen.getByText("未能载入告警")).toBeTruthy();
  });

  it("不是当天的告警时刻带月日", () => {
    receive(frame("alerts", { ...alert(1), ts: "2020-01-02T03:04:05Z" }), 0);
    render(<AlertList stale={false} lastFrameAt={0} />);
    const day = new Date("2020-01-02T03:04:05Z").toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" }).replace("/", "-");
    expect(screen.getByRole("list", { name: "单条告警" }).textContent).toContain(day);
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

  it("轨迹规则：标题为类型、规则名与越线方向，疑似加前缀；区域告警的 update、end 不另列（物理告警）", () => {
    const rule = (n: number, extra: object) => ({
      ...base(n),
      camera_id: "cam-01",
      rule_id: "gate",
      rule_name: "大门",
      rule_type: "line_crossing",
      phase: "pulse",
      episode_id: base(n).event_id,
      level: "confirmed",
      track_id: 3,
      object_class: "person",
      x: 1,
      y: 2,
      uncertainty_m: 0.2,
      since: base(n).ts,
      direction: "forward",
      mapping: "calibrated",
      inferred: false,
      ...extra,
    });
    receive(frame("alerts", rule(1, {})), 0);
    receive(frame("alerts", rule(2, { rule_id: "yard", rule_name: "库区", rule_type: "intrusion", phase: "start", direction: null, level: "suspected" })), 0);
    receive(frame("alerts", rule(3, { rule_id: "yard", rule_name: "库区", rule_type: "intrusion", phase: "end", direction: null })), 0);
    render(<AlertList stale={false} lastFrameAt={0} />);

    const items = within(screen.getByRole("list", { name: "单条告警" })).getAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual([expect.stringContaining("疑似区域入侵 · 库区"), expect.stringContaining("越线 · 大门（正向）")]);
    expect(within(items[0] as HTMLElement).getByLabelText("物理告警")).toBeTruthy();
    expect(within(items[1] as HTMLElement).getByLabelText("规则")).toBeTruthy();
  });

  it("疑似跌倒标为疑似；确认后与之合并为一行，标题随最新一条（TK-160）", () => {
    receive(frame("alerts", { ...fall(1), level: "suspected" }), 0);
    render(<AlertList stale={false} lastFrameAt={0} />);
    expect(screen.getByText("疑似跌倒")).toBeTruthy();

    act(() => receive(frame("alerts", { ...fall(2), level: "confirmed" }), 0));

    const items = within(screen.getByRole("list", { name: "单条告警" })).getAllByRole("listitem");
    expect(items).toHaveLength(1);
    expect(screen.queryByText("疑似跌倒")).toBeNull();
    expect(items[0]?.textContent).toContain("跌倒");
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

  it("目标未登记为设备的网络告警标出被攻击地址并说明不处置，不可选中（FR-203）", () => {
    receive(frame("alerts", { ...alert(1), device_id: null }), 0);
    render(<AlertList stale={false} lastFrameAt={0} />);

    const label = screen.getByText(/未登记设备 172\.30\.0\.12/);
    expect(label.getAttribute("title")).toContain("不自动处置");
    expect(screen.getByText("告警 1").closest("button")).toHaveProperty("disabled", true);
  });

  it("控制台登录爆破（HYD-WEB-0001）标为管理平台遭攻击，而不是未登记设备", () => {
    receive(frame("alerts", { ...alert(1), rule_id: "HYD-WEB-0001", device_id: null, dst_ip: "192.168.5.199" }), 0);
    render(<AlertList stale={false} lastFrameAt={0} />);

    const label = screen.getByText(/管理平台 192\.168\.5\.199/);
    expect(label.getAttribute("title")).toContain("管理平台自身遭攻击");
    expect(screen.queryByText(/未登记设备/)).toBeNull();
  });
});

describe("按关联事件选中", () => {
  it("同一设备的两起关联事件：点哪起选中哪起；只选设备时高亮最近的一起，点设备重置为最近", () => {
    const older = { ...incident, id: "inc-old", title: "较早的事件" };
    const newer = { ...incident, id: "inc-new", title: "最近的事件" };
    receive(frame("incidents", older), 0);
    receive(frame("incidents", newer), 0);
    render(<AlertList stale={false} lastFrameAt={0} />);
    const current = () => screen.getAllByRole("button").filter((b) => b.getAttribute("aria-current")).map((b) => b.textContent);

    fireEvent.click(screen.getByText("较早的事件"));
    expect(useSelection.getState()).toMatchObject({ deviceId: "cam-02", incidentId: "inc-old" });
    expect(current()).toEqual([expect.stringContaining("较早的事件")]);

    act(() => select("cam-02"));
    expect(useSelection.getState().incidentId).toBeNull();
    expect(current()).toEqual([expect.stringContaining("最近的事件")]);
  });
});

describe("告警栏筛选（D-112）", () => {
  it("物理只显示行为告警与物理域关联事件，网络只显示网络告警与网络关联事件；筛选后为空时提示", () => {
    const occluded = { ...incident, id: "inc-2", rule_id: "HYD-VIS-0001", title: "摄像头镜头遭遮挡或挪位", severity: "medium", device_ids: ["cam-01"], source_ip: null };
    receive(frame("alerts", alert(1)), 0);
    receive(frame("alerts", fall(2)), 0);
    receive(frame("incidents", incident), 0);
    receive(frame("incidents", occluded), 0);
    render(<AlertList stale={false} lastFrameAt={0} />);
    const shown = () => within(screen.getByRole("list", { name: "单条告警" })).getAllByRole("listitem").map((li) => li.textContent);
    const pinned = () => within(screen.getByRole("list", { name: "关联事件" })).getAllByRole("listitem").map((li) => li.textContent);

    fireEvent.click(screen.getByRole("radio", { name: "物理" }));
    expect(shown()).toEqual([expect.stringContaining("跌倒")]);
    expect(pinned()).toEqual([expect.stringContaining("镜头遭遮挡")]);
    // 物理域事件没有攻击源：标为物理告警，状态为无需封禁
    const row = within(screen.getByRole("list", { name: "关联事件" }));
    expect(row.getByLabelText("物理告警")).toBeTruthy();
    expect(row.getByText("无需封禁")).toBeTruthy();

    fireEvent.click(screen.getByRole("radio", { name: "网络" }));
    expect(shown()).toEqual([expect.stringContaining("告警 1")]);
    expect(pinned()).toEqual([expect.stringContaining("画面遭篡改")]);
  });

  it("该类没有告警时显示空态", () => {
    receive(frame("alerts", alert(1)), 0);
    render(<AlertList stale={false} lastFrameAt={0} />);
    fireEvent.click(screen.getByRole("radio", { name: "物理" }));
    expect(screen.getByText("该类暂无告警")).toBeTruthy();
  });
});

describe("同类告警合并（D-106）", () => {
  const climb = (n: number, minute: number, camera = "cam-02") => ({
    ...fall(n),
    camera_id: camera,
    behavior: "climb",
    ts: `2026-11-08T02:${String(minute).padStart(2, "0")}:00Z`,
  });

  it("同一摄像头同类行为 5 分钟内合并，超出另起一行；不同摄像头、不同行为不合并", () => {
    const alerts = [climb(1, 20), climb(2, 18), fall(3), climb(4, 16), climb(5, 9), climb(6, 15, "cam-01")]
      .map((a) => a as never)
      .sort((a: { ts: string }, b: { ts: string }) => b.ts.localeCompare(a.ts));
    const groups = groupAlerts(alerts);
    const summary = groups.map((g) => [g.alerts[0].event_id.slice(-2), g.alerts.length]);
    expect(summary).toEqual([
      ["01", 3],
      ["06", 1],
      ["05", 1],
      ["03", 1],
    ]);
  });

  it("网络告警按设备、规则与来源合并", () => {
    const groups = groupAlerts([alert(3), alert(2, "model"), alert(1)] as never);
    expect(groups.map((g) => g.alerts.length)).toEqual([2, 1]);
  });

  it("合并行显示次数，展开后逐条列出", () => {
    for (const n of [1, 2, 3]) receive(frame("alerts", alert(n)), 0);
    render(<AlertList stale={false} lastFrameAt={0} />);
    const list = screen.getByRole("list", { name: "单条告警" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    expect(list.textContent).toContain("×3");

    fireEvent.click(screen.getByRole("button", { name: "展开 3 条" }));
    expect(within(screen.getByRole("list", { name: "合并的告警" })).getAllByRole("listitem")).toHaveLength(3);
  });

  it("新告警并入已展开的行时保持展开", () => {
    for (const n of [1, 2, 3]) receive(frame("alerts", alert(n)), 0);
    render(<AlertList stale={false} lastFrameAt={0} />);
    fireEvent.click(screen.getByRole("button", { name: "展开 3 条" }));

    act(() => receive(frame("alerts", alert(4)), 0));

    expect(within(screen.getByRole("list", { name: "合并的告警" })).getAllByRole("listitem")).toHaveLength(4);
  });

  it("最早的告警被保留上限挤出时，已展开的行保持展开", () => {
    for (const n of [1, 2, 3]) receive(frame("alerts", alert(n)), 0);
    render(<AlertList stale={false} lastFrameAt={0} />);
    fireEvent.click(screen.getByRole("button", { name: "展开 3 条" }));

    act(() => useLive.setState((s) => ({ alerts: s.alerts.slice(0, -1) })));

    expect(within(screen.getByRole("list", { name: "合并的告警" })).getAllByRole("listitem")).toHaveLength(2);
  });

  it("行编号沿用上一次分组：新告警并入、最早的被挤出都不变", () => {
    const first = groupAlerts([alert(3), alert(2), alert(1)] as never);
    const previous = new Map(first.flatMap((g) => g.alerts.map((a) => [a.event_id, g.id] as const)));
    const next = groupAlerts([alert(4), alert(3), alert(2)] as never, previous);
    expect(next.map((g) => g.id)).toEqual(first.map((g) => g.id));
  });
});

describe("网络告警标题", () => {
  it("自研规则按分类显示中文标题，规则编号与签名原文放在说明里；外部规则照原文", () => {
    const own = { ...alert(1), rule_id: "HYD-NET-0001", category: "auth_bruteforce", summary: "HYD-NET-0001 RTSP authentication brute force" };
    const shown = describeAlert(own as Parameters<typeof describeAlert>[0]);
    expect(shown.title).toBe("口令暴力破解");
    expect(shown.detail).toBe("HYD-NET-0001 · HYD-NET-0001 RTSP authentication brute force");
    expect(describeAlert(alert(2) as Parameters<typeof describeAlert>[0]).title).toBe("告警 2");
  });
});
