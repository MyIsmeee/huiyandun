import { describe, expect, it } from "vitest";
import {
  analyze, buildGraph, buildView, describe as describeNode, GROUP_MIN, narrative, nodeId, subgraph, type LiveData,
} from "../../src/panels/RelationGraph/model";
import type { Alert, Device, Execution, Incident } from "../../src/store/live";

const device = (id: string, ip: string, type: Device["type"] = "camera", state: Device["state"] = "normal"): Device =>
  ({ id, name: id, type, ip, mode: "bypass", state, alert_severity: null, camera: null }) as Device;

let seq = 0;
const net = (src: string, deviceId: string | null, dst: string, patch: Record<string, unknown> = {}): Alert =>
  ({
    event_id: `e-${++seq}`, ts: "2026-11-18T08:00:00.000Z", schema_version: "1.0.0", rule_id: "HYD-NET-0001", rule_version: "1",
    mode: "enforce", category: "auth_bruteforce", severity: "high", src_ip: src, dst_ip: dst, device_id: deviceId,
    technique: "T1110", evidence_ref: "x", source: "rule", confidence: 1, summary: "RTSP auth brute force", ...patch,
  }) as unknown as Alert;

const behavior = (camera: string, b = "fall", level = "confirmed"): Alert =>
  ({ event_id: `e-${++seq}`, ts: "2026-11-18T08:01:00.000Z", camera_id: camera, track_id: 1, behavior: b, level, confidence_avg: 0.9 }) as unknown as Alert;

const incident = (patch: Partial<Incident>): Incident =>
  ({
    id: "inc-1", rule_id: "HYD-COR-0001", rule_version: "1", mode: "enforce", title: "摄像头口令爆破", severity: "high",
    device_ids: ["cam-01"], source_ip: "10.9.9.9", techniques: ["T1110"], tactics: ["credential-access"], evidence_refs: [],
    hit_path: [], requires_confirmation: false, status: "open", created_at: "2026-11-18T08:02:00.000Z", ...patch,
  }) as Incident;

const execution = (patch: Partial<Execution>): Execution =>
  ({
    id: "exec-1", playbook_id: "block-ip", playbook_version: "1", incident_id: "inc-1", device_ids: ["cam-01"], target: "10.9.9.9",
    state: "contained", reason: null, ttl_s: 1800, expires_at: "2026-11-18T08:32:00.000Z", verify_result: null, ...patch,
  }) as Execution;

const devices = [device("cam-01", "192.168.1.11"), device("cam-02", "192.168.1.12"), device("cam-03", "192.168.1.13"), device("nvr-01", "192.168.1.20", "nvr")];

function data(patch: Partial<LiveData>): LiveData {
  return { devices, alerts: [], incidents: [], executions: {}, ...patch };
}

describe("buildGraph + subgraph：以摄像头为中心", () => {
  it("攻击源、攻击类型、ATT&CK 技术、关联事件与处置都和被攻击的摄像头连起来", () => {
    const a1 = net("10.9.9.9", "cam-01", "192.168.1.11");
    const a2 = net("10.9.9.9", "cam-01", "192.168.1.11");
    const inc = incident({ hit_path: [a1.event_id as never] });
    const full = buildGraph(data({ alerts: [a1, a2], incidents: [inc], executions: { "exec-1": execution({}) } }));
    const g = subgraph(full, nodeId.device("cam-01"));
    const ids = new Set(g.nodes.map((n) => n.id));
    for (const id of ["dev:cam-01", "ip:10.9.9.9", "atk:HYD-NET-0001", "tech:T1110", "inc:inc-1", "exe:exec-1"]) expect(ids).toContain(id);
    // 没有记录的设备不出现
    expect(ids).not.toContain("dev:cam-02");
    const attacked = g.links.find((l) => l.kind === "attacked");
    expect(attacked).toMatchObject({ source: "ip:10.9.9.9", target: "dev:cam-01", count: 2 });
    expect(g.links.some((l) => l.kind === "hit" && l.target === "atk:HYD-NET-0001")).toBe(true);
    expect(g.links.some((l) => l.kind === "blocked" && l.target === "ip:10.9.9.9")).toBe(true);
    expect(g.nodes.find((n) => n.id === "ip:10.9.9.9")?.props.blocked).toBe("contained");
  });

  it("同一攻击源打过的其他设备两跳内可见并列为关联设备；只是同一种攻击不算关联", () => {
    const alerts = [
      net("10.9.9.9", "cam-01", "192.168.1.11"),
      net("10.9.9.9", "nvr-01", "192.168.1.20"),
      net("10.7.7.7", "cam-03", "192.168.1.13"), // 同一规则、不同攻击源
    ];
    const g = subgraph(buildGraph(data({ alerts })), nodeId.device("cam-01"));
    const ids = new Set(g.nodes.map((n) => n.id));
    expect(ids).toContain("dev:nvr-01");
    expect(ids).not.toContain("dev:cam-03");
    expect(ids).not.toContain("ip:10.7.7.7");
    const s = analyze(g);
    expect(s.relations.map((r) => r.device.id)).toEqual(["dev:nvr-01"]);
    expect(narrative("cam-01", s)).toContain("同一攻击源还攻击了 nvr-01");
  });

  it("告警指向未登记的地址时作为未登记设备出现；按地址能找到设备时归到该设备", () => {
    const full = buildGraph(data({ alerts: [net("10.9.9.9", null, "192.168.1.12"), net("10.9.9.9", null, "192.168.1.99")] }));
    expect(full.links.some((l) => l.kind === "attacked" && l.target === "dev:cam-02")).toBe(true);
    const unknown = full.nodes.find((n) => n.id === "dst:192.168.1.99");
    expect(unknown?.props.unregistered).toBe(true);
  });

  it("画面事件按摄像头与行为合并，疑似事件为弱关系", () => {
    const g = subgraph(buildGraph(data({ alerts: [behavior("cam-02"), behavior("cam-02", "fall", "suspected")] })), nodeId.device("cam-02"));
    const scene = g.nodes.find((n) => n.kind === "scene");
    expect(scene).toMatchObject({ label: "跌倒", props: { alerts: 2, suspected: 1 } });
    expect(g.links.find((l) => l.kind === "detected")?.weak).toBe(false);
    expect(narrative("cam-02", analyze(g))).toContain("跌倒 2 次");
  });

  it("中心不在图里时返回空图", () => {
    expect(subgraph(buildGraph(data({})), "dev:nope")).toEqual({ center: "dev:nope", nodes: [], links: [] });
  });
});

describe("buildView：折叠与筛选", () => {
  it("只攻击过这一台、没有关联事件的攻击源达到阈值时折叠，展开后逐个显示", () => {
    const alerts = Array.from({ length: GROUP_MIN }, (_, i) => net(`10.1.0.${i + 1}`, "cam-01", "192.168.1.11"));
    alerts.push(net("10.9.9.9", "cam-01", "192.168.1.11"));
    const inc = incident({});
    const g = subgraph(buildGraph(data({ alerts, incidents: [inc] })), nodeId.device("cam-01"));
    const view = buildView(g, new Set(), new Set());
    expect(view.groups).toBe(1);
    const group = view.nodes.find((n) => n.kind === "attacker_group");
    expect(group?.label).toBe(`${GROUP_MIN} 个攻击源`);
    // 有关联事件的攻击源不折叠
    expect(view.nodes.some((n) => n.id === "ip:10.9.9.9")).toBe(true);
    expect(view.edges.some((e) => e.source === group?.id && e.target === "dev:cam-01" && e.count === GROUP_MIN)).toBe(true);
    const open = buildView(g, new Set(), new Set(["dev:cam-01"]));
    expect(open.groups).toBe(0);
    expect(open.nodes.filter((n) => n.kind === "attacker")).toHaveLength(GROUP_MIN + 1);
  });

  it("图例关掉的类型不显示，中心点始终显示", () => {
    const g = subgraph(buildGraph(data({ alerts: [net("10.9.9.9", "cam-01", "192.168.1.11")] })), nodeId.device("cam-01"));
    const view = buildView(g, new Set(["technique", "camera"]), new Set());
    expect(view.nodes.some((n) => n.kind === "technique")).toBe(false);
    expect(view.nodes.some((n) => n.center)).toBe(true);
    expect(view.edges.some((e) => e.kind === "maps_to")).toBe(false);
  });

  it("monitor 模式的告警为弱关系，不计为关联设备", () => {
    const alerts = [net("10.5.5.5", "cam-01", "192.168.1.11", { mode: "monitor" }), net("10.5.5.5", "cam-02", "192.168.1.12", { mode: "monitor" })];
    const g = subgraph(buildGraph(data({ alerts })), nodeId.device("cam-01"));
    const view = buildView(g, new Set(), new Set());
    expect(view.nodes.find((n) => n.id === "ip:10.5.5.5")?.weak).toBe(true);
    expect(analyze(g).relations).toHaveLength(0);
  });
});

describe("describe：点的说明", () => {
  it("攻击源写出攻击过几台设备和处置状态", () => {
    const full = buildGraph(data({ alerts: [net("10.9.9.9", "cam-01", "192.168.1.11")], incidents: [incident({})], executions: { e: execution({ id: "e" }) } }));
    const ip = full.nodes.find((n) => n.id === "ip:10.9.9.9");
    expect(ip).toBeDefined();
    if (!ip) return;
    const d = describeNode(ip, 2);
    expect(d.subtitle).toBe("外部攻击源");
    expect(d.facts).toEqual(expect.arrayContaining([{ label: "攻击过的设备", value: "2 台", tone: "warning" }, { label: "处置", value: "已封禁", tone: undefined }]));
  });
});
