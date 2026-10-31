import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { Site } from "../../../src/lib/api";
import { AlertListView } from "../../../src/panels/AlertList/AlertList";
import { DetailPanel } from "../../../src/panels/DetailPanel/DetailPanel";
import { KpiTile } from "../../../src/panels/KpiTile/KpiTile";
import { LiveVideoView } from "../../../src/panels/LiveVideo/LiveVideo";
import { planView } from "../../../src/scene/layout";
import { Scene2D } from "../../../src/scene/Scene2D";
import type { Alert, Execution, Incident } from "../../../src/store/live";
import "../../../src/theme/store";
import "../../../src/theme/theme.css";

const SITE: Site = {
  id: "demo-office",
  name: "演示办公区",
  width_m: 40,
  height_m: 24,
  walls: [
    [0, 0, 40, 0],
    [40, 0, 40, 24],
    [40, 24, 0, 24],
    [0, 24, 0, 0],
  ],
  doors: [
    [18, 0, 20, 0],
    [0, 10, 0, 12],
  ],
  zones: [{ id: "z-01", name: "设备间外墙", polygon: [[30, 0], [40, 0], [40, 6], [30, 6]], no_climb: true }],
  devices: [],
};
const PLAN_SIZE = { width: 640, height: 400 };
const plan = (site: Site) => (
  <div className="relative" style={PLAN_SIZE}>
    <Scene2D site={site} cameras={[]} view={planView(site, PLAN_SIZE)} />
  </div>
);

/** 代替摄像头的静态画面：画布生成的视频流，截图稳定 */
function testStream(): MediaStream {
  const canvas = Object.assign(document.createElement("canvas"), { width: 640, height: 360 });
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.fillStyle = "#3a3f47";
    ctx.fillRect(0, 0, 640, 360);
    ctx.fillStyle = "#59606b";
    ctx.fillRect(0, 240, 640, 120);
  }
  return canvas.captureStream(1);
}
const STREAM = testStream();
const video = (node: ReactNode) => <div className="w-72">{node}</div>;
/** 没有视频流的设备：详情面板截图不依赖 WebRTC 连接 */
const SWITCH = {
  id: "sw-01",
  type: "switch",
  ip: "10.0.0.2",
  mode: "bypass",
  state: "normal",
  alert_severity: null,
  camera: null,
} as const;

const ALERTS = [
  {
    schema_version: "1.2.0", event_id: "00000000-0000-4000-8000-000000000020", ts: "2026-10-27T06:29:20Z",
    rule_id: "HYD-NET-BEH", rule_version: "1", mode: "enforce", category: "behavior_anomaly",
    severity: "medium", src_ip: "172.30.0.100", dst_ip: "172.30.0.12", device_id: "cam-02",
    technique: "T1110", evidence_ref: "zeek:conn/1", source: "model", confidence: 0.82,
    summary: "陌生访问方，失败率为基线 6 倍",
  },
  {
    schema_version: "1.2.0", event_id: "00000000-0000-4000-8000-000000000010", ts: "2026-10-27T06:29:10Z",
    rule_id: "HYD-NET-0001", rule_version: "3", mode: "enforce", category: "auth_bruteforce",
    severity: "high", src_ip: "172.30.0.100", dst_ip: "172.30.0.12", device_id: "cam-02",
    technique: "T1110", evidence_ref: "suricata:flow/1", source: "rule", confidence: 1,
    summary: "HYD-NET-0001 RTSP authentication brute force",
  },
] as Alert[]; // prettier-ignore
const INCIDENTS = [
  {
    id: "inc-1", rule_id: "HYD-X-0001", rule_version: "1.0.0", mode: "enforce",
    title: "摄像头疑似被入侵且画面遭篡改", severity: "critical", device_ids: ["cam-02"],
    source_ip: "172.30.0.100", techniques: ["T1110"], tactics: ["Credential Access"],
    evidence_refs: [], hit_path: [], requires_confirmation: false, status: "open",
    created_at: "2026-10-27T06:29:40Z",
  },
] as Incident[]; // prettier-ignore
const EXECUTIONS = {
  "exe-1": {
    id: "exe-1", playbook_id: "isolate-attacker", playbook_version: "1.0.0", incident_id: "inc-1",
    device_ids: ["cam-02"], target: "172.30.0.100", state: "contained", reason: null, ttl_s: 150,
    expires_at: "2026-10-27T06:32:10Z", verify_result: { passed: true, reason: "封禁规则已生效" },
  },
} as Record<string, Execution>; // prettier-ignore
const LAST_FRAME = Date.parse("2026-10-27T06:29:45Z");
const alertList = (node: ReactNode) => <div className="flex h-80 w-80 flex-col">{node}</div>;

// 组件各状态的展示页：/tests/e2e/gallery/?component=<组件>，每个状态一个 [data-state]
const GALLERY: Record<string, Record<string, ReactNode>> = {
  KpiTile: {
    normal: <KpiTile label="活跃告警" unit="条" data={{ status: "ready", value: 3, delta: 2 }} />,
    empty: <KpiTile label="活跃告警" unit="条" data={{ status: "ready", value: null, delta: null }} />,
    loading: <KpiTile label="活跃告警" unit="条" data={{ status: "loading" }} />,
    stale: <KpiTile label="活跃告警" unit="条" data={{ status: "stale", value: 3, delta: -1 }} />,
  },
  Scene2D: {
    empty: plan(SITE),
  },
  LiveVideo: {
    normal: video(<LiveVideoView status={{ kind: "playing", stream: STREAM }} />),
    empty: video(<LiveVideoView status={{ kind: "none" }} />),
    loading: video(<LiveVideoView status={{ kind: "connecting" }} />),
    error: video(<LiveVideoView status={{ kind: "unavailable", reason: "视频服务不可用" }} />),
    disconnected: video(<LiveVideoView status={{ kind: "interrupted", stream: STREAM }} />),
  },
  DetailPanel: {
    device: <div className="w-80"><DetailPanel device={SWITCH} stale={false} onClose={() => {}} /></div>,
    disconnected: <div className="w-80"><DetailPanel device={SWITCH} stale onClose={() => {}} /></div>,
  },
  AlertList: {
    normal: alertList(<AlertListView alerts={ALERTS} incidents={INCIDENTS} executions={EXECUTIONS} stale={false} lastFrameAt={LAST_FRAME} />),
    empty: alertList(<AlertListView alerts={[]} incidents={[]} executions={{}} stale={false} lastFrameAt={LAST_FRAME} />),
    disconnected: alertList(<AlertListView alerts={ALERTS} incidents={INCIDENTS} executions={EXECUTIONS} stale lastFrameAt={LAST_FRAME} />),
  },
};

const states = GALLERY[new URLSearchParams(location.search).get("component") ?? ""] ?? {};
const root = document.getElementById("root");
if (!root) throw new Error("index.html 缺少 #root");

createRoot(root).render(
  <main className="flex flex-wrap items-start gap-4 p-6">
    {Object.entries(states).map(([state, node]) => (
      <figure key={state} data-state={state} className="rounded-2xl bg-panel">
        {node}
      </figure>
    ))}
  </main>,
);
