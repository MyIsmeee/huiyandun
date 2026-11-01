import {
  BellRing,
  BookOpen,
  Cctv,
  ChevronDown,
  CircleAlert,
  Clock,
  Film,
  Globe,
  House,
  Network,
  ShieldAlert,
  ShieldCheck,
  Wrench,
} from "lucide-react";
import { Fragment, useEffect, useState } from "react";
import type { components } from "../../api/schema";
import { ApiError, api } from "../../lib/api";
import { useConnection } from "../../store/connection";
import { type Execution, type Incident, useLive } from "../../store/live";
import { canContain, useSession } from "../../store/session";
import { RESULT_TIMEOUT_MS } from "../ActionBar/ActionBar";
import { SEVERITY } from "../AlertList/AlertList";

export type Investigation = components["schemas"]["Investigation"];
type Verdict = NonNullable<Investigation["verdict"]>;
export type InvestigationLoad =
  | { status: keyof typeof NO_RECORD }
  | { status: "ready"; investigation: Investigation };
export type ConfirmRequest = { status: "idle" | "pending" } | { status: "failed"; message: string };

/** 工具类型图标（V-AI6）；未知工具（已被拒绝的调用）用通用图标 */
const TOOL_ICON: Record<string, typeof Wrench> = {
  list_alerts: BellRing,
  list_frame_events: Film,
  get_device: Cctv,
  query_sessions: Network,
  lookup_technique: BookOpen,
};
const UNVERIFIED = "该实体未能在证据中溯源";
const NO_RECORD = { loading: "读取调查记录…", none: "尚未开始调查", failed: "无法读取调查记录" } as const;

/**
 * AI 安全值班员面板（HYD-UIX-004 §6.2、§8 AiInvestigation）：所选设备最近一个关联事件的规则结论与 AI 研判，分区显示
 * （V-AI1、V-AI8）。调查记录读 GET 接口，每收到该事件的 ai 推送或推送连接恢复时重新读取（FR-1102）。
 * 规则结论下方是"确认处置"：事件须人工确认、有待确认的执行且角色为 operator 及以上时渲染（V-AI9、C-FE-07）。
 */
export function AiInvestigation(props: { deviceId: string; stale: boolean }) {
  const incident = useLive((s) => s.incidents.find((i) => i.device_ids.includes(props.deviceId)));
  if (!incident) return null;
  // key：换了关联事件即不再显示上一个事件的调查与确认结果
  return <AiInvestigationState key={incident.id} incident={incident} stale={props.stale} />;
}

function AiInvestigationState(props: { incident: Incident; stale: boolean }) {
  const { incident, stale } = props;
  const seq = useLive((s) => s.aiSeq[incident.id]);
  const open = useConnection((s) => s.open);
  const pending = useLive((s) =>
    Object.values(s.executions).find((e) => e.incident_id === incident.id && e.state === "pending"),
  );
  const role = useSession((s) => s.role);
  const [load, setLoad] = useState<InvestigationLoad>({ status: "loading" });
  // 请求记在发起时的那条执行推送上：执行器推送新状态（开始执行）后按钮消失；换了执行即不再显示上一次的结果
  const [confirming, setConfirming] = useState<{ execution: Execution; request: ConfirmRequest } | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let current = true;
    api.getInvestigation(incident.id).then(
      (investigation) => current && setLoad({ status: "ready", investigation }),
      (e: unknown) => {
        if (!current) return;
        // 断线期间重读失败时保留已读到的记录，由断线标注说明（V-U3）
        if (e instanceof ApiError && e.status === 404) setLoad({ status: "none" });
        else setLoad((l) => (l.status === "ready" ? l : { status: "failed" }));
      },
    );
    return () => {
      current = false;
    };
  }, [incident.id, seq, open]);

  const running = load.status === "ready" && load.investigation.finished_at === null;
  useEffect(() => {
    if (!running || stale) return; // 断线时停止计时（V-U3）
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running, stale]);

  async function confirm(execution: Execution) {
    setConfirming({ execution, request: { status: "pending" } });
    try {
      await api.confirmContainment(incident.id);
    } catch (e) {
      const message = e instanceof ApiError ? e.message : "无法连接服务器，请重试";
      setConfirming({ execution, request: { status: "failed", message } });
      return;
    }
    // 执行器停机时确认可能丢失：到时恢复可点
    setTimeout(() => {
      setConfirming((c) =>
        c?.execution === execution && c.request.status === "pending"
          ? { execution, request: { status: "failed", message: "未收到执行结果，请重试" } }
          : c,
      );
    }, RESULT_TIMEOUT_MS);
  }

  const confirmable = incident.requires_confirmation && pending !== undefined && canContain(role);
  return (
    <AiInvestigationView
      incident={incident}
      load={load}
      stale={stale}
      now={now}
      confirm={
        confirmable
          ? {
              execution: pending,
              request: confirming?.execution === pending ? confirming.request : { status: "idle" },
              onConfirm: () => void confirm(pending),
            }
          : null
      }
    />
  );
}

export function AiInvestigationView(props: {
  incident: Incident;
  load: InvestigationLoad;
  stale: boolean;
  now: number;
  confirm: { execution: Execution; request: ConfirmRequest; onConfirm: () => void } | null;
}) {
  const { incident, load, stale, now, confirm } = props;
  return (
    <section aria-label="AI 安全值班员" className="flex flex-col gap-3 rounded-xl border border-line p-3 text-sm">
      <section aria-label="规则结论" className="flex flex-col gap-2">
        <h3 className="font-semibold">规则结论</h3>
        <p>{incident.title}</p>
        <p className="text-fg-2">
          等级 {SEVERITY[incident.severity]}
          {incident.techniques.length > 0 && ` · ${incident.techniques.join(" ")}`}
          {incident.source_ip && <span className="tabular-nums"> · 来源 {incident.source_ip}</span>}
        </p>
        {incident.requires_confirmation && <p className="text-fg-2">含模型证据，处置须人工确认</p>}
        {confirm && (
          <>
            <button
              type="button"
              onClick={confirm.onConfirm}
              disabled={confirm.request.status === "pending"}
              className="min-h-9 self-start rounded-2xl border border-line px-4 py-1.5 text-left transition-colors hover:bg-raised disabled:opacity-40"
            >
              {confirm.request.status === "pending"
                ? "确认中…"
                : `确认处置：${confirm.execution.playbook_id} 封禁 ${confirm.execution.target}`}
            </button>
            {confirm.request.status === "failed" && (
              <p role="alert" className="flex items-start gap-1 text-fg-2">
                <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
                <span className="min-w-0">{confirm.request.message}</span>
              </p>
            )}
          </>
        )}
      </section>
      <section aria-label="AI 研判" className={`flex flex-col gap-2 border-t border-line pt-3 ${stale ? "opacity-60" : ""}`}>
        <header className="sticky top-0 flex flex-wrap items-center gap-x-2 bg-panel">
          <h3 className="font-semibold">AI 研判</h3>
          <span className="text-xs text-fg-3">AI 生成 · 需人工复核</span>
          {stale && (
            <span className="ml-auto inline-flex items-center gap-1 text-xs text-uncertain">
              <Clock aria-hidden className="size-3.5" />
              数据非实时
            </span>
          )}
        </header>
        <InvestigationBody load={load} now={now} />
      </section>
    </section>
  );
}

function InvestigationBody(props: { load: InvestigationLoad; now: number }) {
  const { load, now } = props;
  if (load.status !== "ready") return <p className="text-fg-3">{NO_RECORD[load.status]}</p>;
  const { steps, verdict, error, provider, started_at, finished_at } = load.investigation;
  return (
    <>
      {provider && (
        <p className="flex items-center gap-1.5 text-fg-2">
          {provider.location === "public" ? <Globe aria-hidden className="size-4" /> : <House aria-hidden className="size-4" />}
          {provider.name}
          <span className="rounded-full border border-line px-2 text-xs">
            {provider.location === "public" ? "公网 · 已脱敏" : "内网"}
          </span>
        </p>
      )}
      {steps.length > 0 && (
        <ol className="flex flex-col gap-1.5">
          {steps.map((step, i) => {
            const Icon = TOOL_ICON[step.tool] ?? Wrench;
            return (
              <li key={i}>
                <details className="group">
                  <summary className="flex cursor-pointer items-start gap-2 hover:text-fg-2">
                    <Icon aria-label={step.tool} className="mt-0.5 size-4 shrink-0 text-fg-2" />
                    <span className="min-w-0 flex-1">{step.reason}</span>
                    <ChevronDown aria-hidden className="mt-0.5 size-4 shrink-0 text-fg-3 transition-transform group-open:rotate-180" />
                  </summary>
                  <p className="mt-1 ml-6 text-fg-2">
                    <span className="font-mono text-xs">
                      {step.tool}({step.args_summary})
                    </span>
                    ：{step.result_summary}
                  </p>
                </details>
              </li>
            );
          })}
        </ol>
      )}
      {finished_at === null && (
        <p className="text-fg-3 tabular-nums">
          调查中 · 已用 {Math.max(0, Math.floor((now - Date.parse(started_at)) / 1000))} s
        </p>
      )}
      {verdict && <VerdictCard verdict={verdict} />}
      {error && (
        <p className="flex items-start gap-1 text-fg-2">
          <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span className="min-w-0">AI 研判不可用：{error}</span>
        </p>
      )}
    </>
  );
}

/** 判定卡（V-AI7）：是否攻击以图标形状 + 文字区分，可信度为百分比 + 环形刻度；只展示，不进入任何操作（G-03） */
function VerdictCard({ verdict }: { verdict: Verdict }) {
  const percent = Math.round(verdict.confidence * 100);
  const Icon = verdict.is_attack ? ShieldAlert : ShieldCheck;
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-line p-3">
      <p className="flex items-center gap-2">
        <Icon aria-hidden className="size-5 shrink-0" />
        <span className="font-semibold">{verdict.is_attack ? "判定为攻击" : "判定非攻击"}</span>
        <span className="ml-auto flex items-center gap-1.5 text-fg-2 tabular-nums">
          <svg aria-hidden viewBox="0 0 20 20" className="size-5 -rotate-90">
            <circle cx="10" cy="10" r="8" fill="none" strokeWidth="3" className="stroke-grid" />
            <circle
              cx="10"
              cy="10"
              r="8"
              fill="none"
              strokeWidth="3"
              pathLength="100"
              strokeDasharray={`${percent} 100`}
              className="stroke-fg-2"
            />
          </svg>
          可信度 {percent}%
        </span>
      </p>
      {verdict.techniques.length > 0 && (
        <p className="flex flex-wrap gap-1.5">
          {verdict.techniques.map((t) => (
            <span key={t} className="rounded-full border border-line px-2 font-mono text-xs">
              <Marked text={t} unverified={verdict.unverified} />
            </span>
          ))}
        </p>
      )}
      <p>
        <Marked text={verdict.narrative} unverified={verdict.unverified} />
      </p>
      <p className="text-fg-2">
        处置建议：
        <Marked text={verdict.recommendation} unverified={verdict.unverified} />
      </p>
    </div>
  );
}

/** 未溯源的实体弱化并加虚线下划线，悬停说明（V-AI3、FR-1103） */
function Marked({ text, unverified }: { text: string; unverified: string[] }) {
  // 长的在前：cam-02-1 与 cam-02 同时未溯源时按完整的 cam-02-1 标记
  const entities = unverified.filter(Boolean).sort((a, b) => b.length - a.length);
  if (entities.length === 0) return text;
  const pattern = new RegExp(`(${entities.map((e) => e.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`);
  return text.split(pattern).map((part, i) =>
    // split 带捕获组：奇数位是匹配到的实体
    i % 2 === 1 ? (
      <span key={i} title={UNVERIFIED} className="text-fg-3 underline decoration-dashed underline-offset-4">
        {part}
      </span>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    ),
  );
}
