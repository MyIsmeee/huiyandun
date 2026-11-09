import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { Site } from "../../../src/lib/api";
import {
  AiInvestigationView,
  type ConfirmRequest,
  type Investigation,
  type InvestigationLoad,
} from "../../../src/panels/AiInvestigation/AiInvestigation";
import { AlertListView } from "../../../src/panels/AlertList/AlertList";
import { DetailPanel } from "../../../src/panels/DetailPanel/DetailPanel";
import { KpiTile } from "../../../src/panels/KpiTile/KpiTile";
import { LlmStatusBadgeView } from "../../../src/panels/LlmStatusBadge/LlmStatusBadge";
import { paint } from "../../../src/panels/DetectionOverlay/DetectionOverlay";
import { contentRect } from "../../../src/panels/DetectionOverlay/overlay";
import { LiveVideoView } from "../../../src/panels/LiveVideo/LiveVideo";
import { type TileProps, VideoTileView } from "../../../src/panels/VideoWall/VideoTile";
import { type EditorForm, type Pending, ProviderEditorView, type TestResult } from "../../../src/panels/ProviderEditor/ProviderEditor";
import { type Provider, type ProviderLoad, ProviderListView } from "../../../src/panels/ProviderList/ProviderList";
import { type Report, ReportBarView, ReportPage, type ReportRequest, type ReportsLoad } from "../../../src/panels/ReportBar/ReportBar";
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
  areas: [],
  devices: [],
};
const PLAN_SIZE = { width: 640, height: 400 };
const plan = (site: Site) => (
  <div className="relative" style={PLAN_SIZE}>
    <Scene2D items={[]} cameras={[]} view={planView({ x0: 0, y0: 0, width_m: site.width_m, height_m: site.height_m }, PLAN_SIZE)} />
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
/** 监控墙瓦片（V-W2、V-W3）：固定 16:9 尺寸，与连接逻辑分开 */
function tile(state: TileProps["device"]["state"], extra: Partial<TileProps & { status: Parameters<typeof VideoTileView>[0]["status"] }> = {}) {
  return (
    <div className="h-[203px] w-[360px]">
      <VideoTileView
        device={{ id: "cam-02", name: "街道", state }}
        selected={false}
        persons={0}
        vehicles={0}
        unmapped={false}
        onSelect={() => {}}
        onZoom={() => {}}
        style={{ width: "100%", height: "100%" }}
        status={{ kind: "playing", stream: STREAM }}
        {...extra}
      />
    </div>
  );
}
/** 站立人员的 COCO 17 点（画面归一化，分数已按滞回化为 0 / 1）：头、肩、肘、腕、髋、膝、踝 */
const STANDING: [number, number, number][] = [
  [0.3, 0.2, 1], [0.31, 0.19, 1], [0.29, 0.19, 1], [0.32, 0.2, 1], [0.28, 0.2, 1],
  [0.34, 0.28, 1], [0.26, 0.28, 1], [0.36, 0.4, 1], [0.24, 0.4, 1], [0.37, 0.5, 1], [0.23, 0.5, 0],
  [0.32, 0.52, 1], [0.28, 0.52, 1], [0.33, 0.68, 1], [0.27, 0.68, 1], [0.33, 0.84, 1], [0.27, 0.84, 1],
];
const person = { camera_id: "cam-02", track_id: 12, object_class: "person" as const, x: 0, y: 0, uncertainty_m: 0.3, heading_deg: null, speed_mps: null, bbox: [0.21, 0.15, 0.4, 0.87], keypoints: STANDING, trail: [] };
const car = { ...person, track_id: 7, object_class: "car" as const, bbox: [0.55, 0.45, 0.92, 0.8], keypoints: null };

/** 画面叠加（FR-107）：在灰色画面上按选中与否画一人一车；实时组件依赖 300 ms 内的实测，展示页直接调用绘制函数 */
function overlay(selected: boolean) {
  return (
    <canvas
      width={360}
      height={203}
      className="block rounded-lg bg-[#3a3a3e]"
      ref={(el) => {
        const ctx = el?.getContext("2d");
        if (!ctx) return;
        const rect = contentRect(360, 203, 16 / 9);
        paint(ctx, person, person, rect, selected);
        paint(ctx, car, car, rect, false);
      }}
    />
  );
}
/** 没有视频流的设备：详情面板截图不依赖 WebRTC 连接 */
const SWITCH = {
  id: "sw-01",
  name: "交换机",
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
const INCIDENT = {
  id: "inc-1", rule_id: "HYD-X-0001", rule_version: "1.0.0", mode: "enforce",
  title: "摄像头疑似被入侵且画面遭篡改", severity: "critical", device_ids: ["cam-02"],
  source_ip: "172.30.0.100", techniques: ["T1110"], tactics: ["Credential Access"],
  evidence_refs: [], hit_path: [], requires_confirmation: false, status: "open",
  created_at: "2026-10-27T06:29:40Z",
} as Incident; // prettier-ignore
const INCIDENTS = [INCIDENT];
const EXECUTIONS = {
  "exe-1": {
    id: "exe-1", playbook_id: "isolate-attacker", playbook_version: "1.0.0", incident_id: "inc-1",
    device_ids: ["cam-02"], target: "172.30.0.100", state: "contained", reason: null, ttl_s: 150,
    expires_at: "2026-10-27T06:32:10Z", verify_result: { passed: true, reason: "封禁规则已生效" },
  },
} as Record<string, Execution>; // prettier-ignore
const LAST_FRAME = Date.parse("2026-10-27T06:29:45Z");
// 与告警栏同宽（ui.md §3）
const alertList = (node: ReactNode) => <div className="flex h-96 w-[360px] flex-col bg-card">{node}</div>;
// 详情抽屉相对场景定位（D-112）：放进一块场景大小的容器
const drawer = (node: ReactNode) => <div className="relative h-[640px] w-[480px]">{node}</div>;
const REPORT: Report = {
  id: "rep-1", incident_id: INCIDENT.id,
  facts: { incident: INCIDENT, devices: [], timeline: [], executions: [] },
  ai: null, investigation: null, source: "template", provider_id: null, degraded_reason: "未启用任何模型供应商",
  reviewed_by: null, reviewed_at: null, created_at: "2026-10-27T06:30:00Z",
}; // prettier-ignore
const REPORTS = [{ ...REPORT, id: "rep-2", source: "llm", created_at: "2026-10-27T06:31:00Z" }, { ...REPORT, reviewed_by: "operator" }] as Report[]; // prettier-ignore
const reportBar = (load: ReportsLoad, request: ReportRequest = { status: "idle" }, exporting: ReportRequest = { status: "idle" }) => (
  <div className="w-80 p-3">
    <ReportBarView incident={INCIDENT} load={load} request={request} exporting={exporting} canEdit onGenerate={() => {}} onExport={() => {}} onOpen={() => {}} />
  </div>
); // prettier-ignore
// 报告网页由 gallery.spec.ts 拦截 /api/reports/*/export 返回固定内容
const reportPage = (report: Report, review: ReportRequest = { status: "idle" }) => (
  <div className="h-[480px] w-[960px]">
    <ReportPage report={report} canReview review={review} onReview={() => {}} onClose={() => {}} />
  </div>
);

const TESTED = { suggested_base_url: null, suggested_models: [], tested_at: "2026-10-27T06:20:00Z" };
const LOCAL_PROVIDER: Provider = {
  id: "p-1", name: "家用 5070 · llama.cpp", preset: "llama_cpp", base_url: "http://192.168.1.50:8888/v1",
  api_key_last4: null, model: "qwen3.6-35b-a3b", network: "internal", network_overridden: false,
  structured_output: "json_schema", timeout_s: 60, enabled: true, order: 0, usage_today: { calls: 48, tokens: 61_234 },
  last_test: { ...TESTED, health: "ok", checks: [{ check: "connectivity", ok: true, latency_ms: 312, reason: null, hint: null }] },
}; // prettier-ignore
const PROVIDERS: Provider[] = [
  LOCAL_PROVIDER,
  {
    id: "p-2", name: "DeepSeek 官方", preset: "deepseek", base_url: "https://api.deepseek.com/v1",
    api_key_last4: "3f9a", model: "deepseek-chat", network: "public", network_overridden: false,
    structured_output: null, timeout_s: 60, enabled: false, order: 1, usage_today: { calls: 0, tokens: 0 }, last_test: null,
  },
]; // prettier-ignore
const FAILED_PROVIDER: Provider = {
  ...LOCAL_PROVIDER, id: "p-3", name: "办公室 Ollama", preset: "ollama", base_url: "http://192.168.1.60:11434/v1", order: 1,
  usage_today: { calls: 0, tokens: 0 },
  last_test: { ...TESTED, health: "failed", checks: [{ check: "connectivity", ok: false, latency_ms: null, reason: "60 秒内无响应", hint: "确认地址可达，或调大超时" }] },
}; // prettier-ignore
const providerList = (load: ProviderLoad) => (
  <div className="w-[56rem]">
    <ProviderListView
      load={load} busy={false} testing={null} notice={null} confirm={null}
      onClose={() => {}} onRetry={() => {}} onBlockPublic={() => {}} onToggle={() => {}} onTest={() => {}}
      onDelete={() => {}} onReorder={() => {}} onConfirm={() => {}} onCancel={() => {}} onAdd={() => {}} onEdit={() => {}}
    />
  </div>
); // prettier-ignore
const EDIT_FORM: EditorForm = { ...LOCAL_PROVIDER, api_key: "", network: "auto" };
const PARTIAL: TestResult = {
  ...TESTED, health: "failed", suggested_models: ["qwen3.6-35b-a3b-q4", "qwen3.6-35b"],
  checks: [
    { check: "connectivity", ok: true, latency_ms: 312, reason: null, hint: null },
    { check: "model", ok: false, latency_ms: null, reason: "模型 qwen3.6-35b-a3b 不在供应商的模型列表中", hint: "可改选：qwen3.6-35b-a3b-q4、qwen3.6-35b" },
    { check: "structured_output", ok: false, latency_ms: null, reason: "未检查：前一项未通过", hint: null },
  ],
}; // prettier-ignore
// 对话框为 fixed 定位：transform 使其以外框为定位基准，截图只含对话框
const providerEditor = (form: EditorForm, provider: Provider | null, pending: Pending, message: string | null, result: TestResult | null = null) => (
  <div className="h-[38rem] w-[40rem] [transform:translateZ(0)]">
    <ProviderEditorView
      form={form} provider={provider} models={[]} pending={pending} message={message} result={result}
      onChange={() => {}} onPreset={() => {}} onFetchModels={() => {}} onSave={() => {}} onSaveAndTest={() => {}} onClose={() => {}}
    />
  </div>
); // prettier-ignore

const STEPS = [
  { tool: "list_alerts", args_summary: "ip=172.30.0.100", result_summary: "近 10 分钟 37 条告警，最近：RTSP 认证爆破 172.30.0.100 → 172.30.0.12", reason: "先看攻击源近期的告警" },
  { tool: "query_sessions", args_summary: "ip=172.30.0.100", result_summary: "近 10 分钟 41 个会话，对端 1 个：172.30.0.12:8554 41 次", reason: "核对与摄像头之间的会话" },
  { tool: "list_frame_events", args_summary: "camera_id=cam-02", result_summary: "近 10 分钟 1 条画面事件：freeze（规则，可信度 1.0）", reason: "看画面是否同时异常" },
]; // prettier-ignore
const STARTED = "2026-10-27T06:29:41Z";
const INVESTIGATION: Investigation = {
  incident_id: INCIDENT.id, steps: STEPS, error: null,
  verdict: {
    is_attack: true, confidence: 0.86, techniques: ["T1110", "T1565"],
    narrative: "172.30.0.100 对 cam-02 发起 RTSP 认证爆破，随后画面冻结，10.9.9.9 疑似参与篡改。",
    recommendation: "隔离 172.30.0.100，核查 cam-02 账户与固件。",
    unverified: ["10.9.9.9", "T1565"],
  },
  provider: { name: "DeepSeek", location: "public" }, started_at: STARTED, finished_at: "2026-10-27T06:30:14Z",
}; // prettier-ignore
const RUNNING: Investigation = {
  ...INVESTIGATION, steps: STEPS.slice(0, 2), verdict: null, finished_at: null,
  provider: { name: "本地 Qwen", location: "internal" },
}; // prettier-ignore
const FAILED: Investigation = {
  ...INVESTIGATION, steps: [], verdict: null, provider: null, error: "未启用任何模型供应商",
}; // prettier-ignore
const PENDING = { ...EXECUTIONS["exe-1"], state: "pending", reason: "含模型证据，等待人工确认", expires_at: null, verify_result: null } as Execution; // prettier-ignore
const NOW = Date.parse(STARTED) + 18_000;
const aiPanel = (load: InvestigationLoad, options: { stale?: boolean; confirm?: ConfirmRequest } = {}) => (
  <div className="w-80 p-3">
    <AiInvestigationView
      incident={{ ...INCIDENT, requires_confirmation: true }}
      load={load}
      stale={options.stale ?? false}
      now={NOW}
      confirm={options.confirm ? { execution: PENDING, request: options.confirm, onConfirm: () => {} } : null}
    />
  </div>
);

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
    device: drawer(<DetailPanel device={SWITCH} stale={false} onClose={() => {}} />),
    disconnected: drawer(<DetailPanel device={SWITCH} stale onClose={() => {}} />),
  },
  DetectionOverlay: {
    normal: overlay(false),
    selected: overlay(true),
  },
  VideoTile: {
    normal: tile("normal", { persons: 3, vehicles: 1 }),
    loading: tile("normal", { status: { kind: "connecting" } }),
    error: tile("normal", { status: { kind: "unavailable", reason: "视频服务不可用" } }),
    physical: tile("physical_alert", { behavior: "攀爬", persons: 1 }),
    cyber: tile("cyber_alert"),
    contained: tile("contained"),
    selected: tile("normal", { selected: true, persons: 2 }),
    disconnected: tile("offline", { status: { kind: "interrupted", stream: STREAM } }),
    unmapped: tile("uncalibrated", { unmapped: true }),
  },
  AlertList: {
    normal: alertList(<AlertListView alerts={ALERTS} incidents={INCIDENTS} executions={EXECUTIONS} stale={false} lastFrameAt={LAST_FRAME} />),
    empty: alertList(<AlertListView alerts={[]} incidents={[]} executions={{}} stale={false} lastFrameAt={LAST_FRAME} />),
    disconnected: alertList(<AlertListView alerts={ALERTS} incidents={INCIDENTS} executions={EXECUTIONS} stale lastFrameAt={LAST_FRAME} />),
  },
  AiInvestigation: {
    normal: aiPanel({ status: "ready", investigation: INVESTIGATION }, { confirm: { status: "idle" } }),
    running: aiPanel({ status: "ready", investigation: RUNNING }),
    unavailable: aiPanel({ status: "ready", investigation: FAILED }, { confirm: { status: "failed", message: "处置执行器暂不可达，请稍后重试" } }),
    empty: aiPanel({ status: "none" }),
    loading: aiPanel({ status: "loading" }),
    error: aiPanel({ status: "failed" }),
    disconnected: aiPanel({ status: "ready", investigation: RUNNING }, { stale: true }),
  },
  ReportBar: {
    empty: reportBar({ status: "ready", reports: [] }),
    loading: reportBar({ status: "loading" }),
    normal: reportBar({ status: "ready", reports: REPORTS }),
    generating: reportBar({ status: "ready", reports: REPORTS }, { status: "pending" }, { status: "pending" }),
    error: reportBar({ status: "failed" }, { status: "failed", message: "关联事件不存在或已超过 24 小时" }, { status: "failed", message: "存证服务暂不可达，请稍后重试" }), // prettier-ignore
  },
  ReportPage: {
    draft: reportPage(REPORT),
    reviewed: reportPage({ ...REPORT, reviewed_by: "operator", reviewed_at: "2026-10-27T06:35:00Z" }),
    error: reportPage(REPORT, { status: "failed", message: "报告已由 admin 复核" }),
  },
  LlmStatusBadge: {
    normal: <LlmStatusBadgeView load={{ status: "ready", data: { state: "normal", provider_name: "本地 llama.cpp", reason: null } }} />,
    failover: <LlmStatusBadgeView load={{ status: "ready", data: { state: "failover", provider_name: "DeepSeek 备用", reason: null } }} />,
    template: <LlmStatusBadgeView load={{ status: "ready", data: { state: "template", provider_name: null, reason: "未启用任何模型供应商" } }} />,
    loading: <LlmStatusBadgeView load={{ status: "loading" }} />,
    error: <LlmStatusBadgeView load={{ status: "error" }} />,
  },
  ProviderList: {
    normal: providerList({ status: "ready", providers: PROVIDERS, blockPublic: false }),
    failing: providerList({ status: "ready", providers: [LOCAL_PROVIDER, FAILED_PROVIDER], blockPublic: false }),
    blocked: providerList({ status: "ready", providers: PROVIDERS, blockPublic: true }),
    empty: providerList({ status: "ready", providers: [], blockPublic: false }),
    loading: providerList({ status: "loading" }),
    error: providerList({ status: "failed", message: "无法连接服务器，请重试" }),
  },
  ProviderEditor: {
    new: providerEditor({ ...EDIT_FORM, name: "llama.cpp", base_url: "http://127.0.0.1:8080/v1", model: "" }, null, null, null),
    edit: providerEditor(EDIT_FORM, { ...LOCAL_PROVIDER, api_key_last4: "3f9a" }, null, null),
    saving: providerEditor(EDIT_FORM, LOCAL_PROVIDER, "save", null),
    error: providerEditor(EDIT_FORM, LOCAL_PROVIDER, null, "地址须为 http:// 或 https:// 开头的 OpenAI 兼容地址"),
    testing: providerEditor(EDIT_FORM, LOCAL_PROVIDER, "test", null),
    partial: providerEditor(EDIT_FORM, LOCAL_PROVIDER, null, null, PARTIAL),
  },
};

const params = new URLSearchParams(location.search);
const all = GALLERY[params.get("component") ?? ""] ?? {};
// 指定 state 时只渲染这一个状态：对话框经 Radix 渲染到 body 并居中，同时打开多个会互相叠盖
const only = params.get("state");
const states = only ? Object.fromEntries(Object.entries(all).filter(([state]) => state === only)) : all;
const root = document.getElementById("root");
if (!root) throw new Error("index.html 缺少 #root");

createRoot(root).render(
  <main className="flex flex-wrap items-start gap-4 p-6">
    {Object.entries(states).map(([state, node]) => (
      <figure key={state} data-state={state} className="rounded-lg bg-card">
        {node}
      </figure>
    ))}
  </main>,
);
