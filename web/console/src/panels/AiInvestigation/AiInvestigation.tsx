import {
  Activity,
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
import { Button } from "@/components/ui/button";
import { Item } from "@/components/ui/item";
import { Fragment, useEffect, useState } from "react";
import type { components } from "../../api/schema";
import { ApiError, api } from "../../lib/api";
import { useConnection } from "../../store/connection";
import { type Execution, type Incident, useLive } from "../../store/live";
import { canContain, useSession } from "../../store/session";
import { RESULT_TIMEOUT_MS } from "../ActionBar/ActionBar";
import { SEVERITY } from "../AlertList/AlertList";
import { awaitingInvestigation, RETRY_MS, useDeviceIncident } from "../IncidentTimeline/IncidentTimeline";

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
  get_baseline: Activity,
  lookup_technique: BookOpen,
};
const UNVERIFIED = "该实体未能在证据中溯源";
const NO_RECORD = {
  loading: "读取调查记录…",
  waiting: "等待调查…",
  none: "尚未开始调查",
  failed: "无法读取调查记录，正在重试",
} as const;
/** 等待调查期间重读的间隔：调查记录在第一轮模型调用返回后才推送首帧 */
const WAIT_POLL_MS = 5_000;
/** 处置剧本的中文名（playbooks/*.yaml 首行注释）；未列出的显示编号 */
const PLAYBOOK: Record<string, string> = { "isolate-attacker": "封禁攻击源", "isolate-attacker-linked": "经外部防火墙封禁攻击源" };

/**
 * AI 安全值班员面板（ui.md §6.2 AiInvestigation）：告警栏点选的（否则所选设备最近一个）关联事件的规则结论与 AI 研判，分区显示
 * （V-AI1、V-AI8）。调查记录读 GET 接口，每收到该事件的 ai 推送或推送连接恢复时重新读取（FR-1102）；
 * 等待调查（尚无记录但仍在调查范围内）时每 5 s 重读，读取失败时 5 s 后重试。
 * 规则结论下方是"确认处置"：事件须人工确认、有待确认的执行且角色为 operator 及以上时渲染（V-AI9、C-FE-07）。
 */
export function AiInvestigation(props: { deviceId: string; stale: boolean }) {
  const incident = useDeviceIncident(props.deviceId);
  if (!incident) return null;
  // key：换了关联事件即不再显示上一个事件的调查与确认结果
  return <AiInvestigationState key={incident.id} incident={incident} stale={props.stale} />;
}

function AiInvestigationState(props: { incident: Incident; stale: boolean }) {
  const { incident, stale } = props;
  const seq = useLive((s) => s.aiSeq[incident.id]);
  const epoch = useConnection((s) => s.epoch);
  const pending = useLive((s) =>
    Object.values(s.executions).find((e) => e.incident_id === incident.id && e.state === "pending"),
  );
  const role = useSession((s) => s.role);
  const [load, setLoad] = useState<InvestigationLoad>({ status: "loading" });
  /** 已读到记录后的重读失败：保留记录，但不再按它显示仍在计时的"调查中"（记录可能早已结束） */
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  // 请求记在发起时的执行 id 上：同一执行的重复推送（重连补推、拦截证据补注）不清掉请求状态；执行器推送新状态
  // （开始执行）后它不再是待确认的执行，按钮消失；换了执行即不再显示上一次的结果
  const [confirming, setConfirming] = useState<{ executionId: string; request: ConfirmRequest } | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const { id, severity, created_at } = incident;
  useEffect(() => {
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const again = (ms: number) => {
      timer = setTimeout(() => setRetry((n) => n + 1), ms);
    };
    api.getInvestigation(id).then(
      (investigation) => {
        if (!current) return;
        setLoad({ status: "ready", investigation });
        setRefreshFailed(false);
      },
      (e: unknown) => {
        if (!current) return;
        if (e instanceof ApiError && e.status === 404) {
          const waiting = awaitingInvestigation({ severity, created_at }, Date.now());
          setLoad({ status: waiting ? "waiting" : "none" });
          setRefreshFailed(false);
          if (waiting) again(WAIT_POLL_MS);
          return;
        }
        // 已读到的记录保留，标注重读失败；断线期间不重试，连上后 epoch 变化即重读（V-U3）
        setLoad((l) => (l.status === "ready" ? l : { status: "failed" }));
        setRefreshFailed(true);
        if (useConnection.getState().open) again(RETRY_MS);
      },
    );
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [id, severity, created_at, seq, epoch, retry]);

  const running = load.status === "ready" && load.investigation.finished_at === null && !refreshFailed;
  useEffect(() => {
    if (!running || stale) return; // 断线时停止计时（V-U3）
    const tick = () => setNow(Date.now());
    // 进入计时即取当前时刻：面板打开很久后才开始的调查，首秒不显示按打开时刻算出的耗时
    const first = setTimeout(tick, 0);
    const timer = setInterval(tick, 1000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [running, stale]);

  async function confirm(execution: Execution) {
    const executionId = execution.id;
    setConfirming({ executionId, request: { status: "pending" } });
    try {
      await api.confirmContainment(incident.id);
    } catch (e) {
      const message = e instanceof ApiError ? e.message : "无法连接服务器，请重试";
      setConfirming({ executionId, request: { status: "failed", message } });
      return;
    }
    // 执行器停机时确认可能丢失：到时恢复可点
    setTimeout(() => {
      setConfirming((c) =>
        c?.executionId === executionId && c.request.status === "pending"
          ? { executionId, request: { status: "failed", message: "未收到执行结果，请重试" } }
          : c,
      );
    }, RESULT_TIMEOUT_MS);
  }

  const confirmable = incident.requires_confirmation && pending !== undefined && canContain(role);
  return (
    <AiInvestigationView
      incident={incident}
      load={load}
      refreshFailed={refreshFailed}
      stale={stale}
      now={now}
      confirm={
        confirmable
          ? {
              execution: pending,
              request: confirming?.executionId === pending.id ? confirming.request : { status: "idle" },
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
  /** 已读到记录后的重读失败 */
  refreshFailed?: boolean;
  stale: boolean;
  now: number;
  confirm: { execution: Execution; request: ConfirmRequest; onConfirm: () => void } | null;
}) {
  const { incident, load, refreshFailed = false, stale, now, confirm } = props;
  return (
    <section aria-label="AI 安全值班员" className="flex flex-col gap-4 text-sm">
      <section aria-label="规则结论" className="flex flex-col gap-2 border-t pt-4">
        <h3 className="font-medium">规则结论</h3>
        <p>{incident.title}</p>
        <p className="text-muted-foreground">
          等级 {SEVERITY[incident.severity]}
          {incident.techniques.length > 0 && ` · ${incident.techniques.join(" ")}`}
          {incident.source_ip && <span className="tabular-nums"> · 来源 {incident.source_ip}</span>}
        </p>
        {incident.requires_confirmation && <p className="text-muted-foreground">含模型证据，处置须人工确认</p>}
        {confirm && (
          <>
            <Button
              onClick={confirm.onConfirm}
              disabled={confirm.request.status === "pending"}
              className="h-auto min-h-9 self-start py-1.5 text-left whitespace-normal"
            >
              {confirm.request.status === "pending"
                ? "确认中…"
                : `确认处置：${PLAYBOOK[confirm.execution.playbook_id] ?? `${confirm.execution.playbook_id} 封禁`} ${confirm.execution.target}`}
            </Button>
            {confirm.request.status === "failed" && (
              <p role="alert" className="flex items-start gap-1 text-muted-foreground">
                <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
                <span className="min-w-0">{confirm.request.message}</span>
              </p>
            )}
          </>
        )}
      </section>
      <section aria-label="AI 研判" className={`flex flex-col gap-2 rounded-lg bg-secondary p-3 ${stale ? "opacity-60" : ""}`}>
        <header className="sticky top-0 z-10 -mx-3 -mt-3 flex flex-wrap items-center gap-x-2 rounded-t-lg bg-secondary px-3 pt-3 pb-1">
          <h3 className="font-medium">AI 研判</h3>
          <span className="text-xs text-subtle-foreground">AI 生成 · 需人工复核</span>
          {stale && (
            <span className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground">
              <Clock aria-hidden className="size-3.5" />
              数据非实时
            </span>
          )}
        </header>
        <InvestigationBody load={load} refreshFailed={refreshFailed} now={now} />
      </section>
    </section>
  );
}

function InvestigationBody(props: { load: InvestigationLoad; refreshFailed: boolean; now: number }) {
  const { load, refreshFailed, now } = props;
  if (load.status !== "ready") return <p className="text-subtle-foreground">{NO_RECORD[load.status]}</p>;
  const { steps, verdict, error, provider, started_at, finished_at } = load.investigation;
  return (
    <>
      {provider && (
        <p className="flex items-center gap-1.5 text-muted-foreground">
          {provider.location === "public" ? <Globe aria-hidden className="size-4" /> : <House aria-hidden className="size-4" />}
          {provider.name}
          <span className="rounded-full border border-border px-2 text-xs">
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
                  <Item asChild className="cursor-pointer flex-nowrap items-start gap-2 p-0 hover:text-muted-foreground">
                    <summary>
                      <Icon aria-label={step.tool} className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1">{step.reason}</span>
                      <ChevronDown aria-hidden className="mt-0.5 size-4 shrink-0 text-subtle-foreground transition-transform group-open:rotate-180" />
                    </summary>
                  </Item>
                  <p className="mt-1 ml-6 text-muted-foreground">
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
        <p className="text-subtle-foreground tabular-nums">
          {refreshFailed
            ? "调查记录读取失败，正在重试"
            : `调查中 · 已用 ${Math.max(0, Math.floor((now - Date.parse(started_at)) / 1000))} s`}
        </p>
      )}
      {verdict && <VerdictCard verdict={verdict} />}
      {error && (
        <p className="flex items-start gap-1 text-muted-foreground">
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
    <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
      <p className="flex items-center gap-2">
        <Icon aria-hidden className="size-5 shrink-0" />
        <span className="font-medium">{verdict.is_attack ? "判定为攻击" : "判定非攻击"}</span>
        <span className="ml-auto flex items-center gap-1.5 text-muted-foreground tabular-nums">
          <svg aria-hidden viewBox="0 0 20 20" className="size-5 -rotate-90">
            <circle cx="10" cy="10" r="8" fill="none" strokeWidth="3" className="stroke-accent" />
            <circle
              cx="10"
              cy="10"
              r="8"
              fill="none"
              strokeWidth="3"
              pathLength="100"
              strokeDasharray={`${percent} 100`}
              className="stroke-muted-foreground"
            />
          </svg>
          可信度 {percent}%
        </span>
      </p>
      {verdict.techniques.length > 0 && (
        <p className="flex flex-wrap gap-1.5">
          {verdict.techniques.map((t) => (
            <span key={t} className="rounded-full border border-border px-2 font-mono text-xs">
              <Marked text={t} unverified={verdict.unverified} />
            </span>
          ))}
        </p>
      )}
      <p>
        <Marked text={verdict.narrative} unverified={verdict.unverified} />
      </p>
      <p className="text-muted-foreground">
        处置建议：
        <Marked text={verdict.recommendation} unverified={verdict.unverified} />
      </p>
    </div>
  );
}

/** 未溯源的实体弱化并加虚线下划线，悬停说明（V-AI3、FR-1103） */
function Marked({ text, unverified }: { text: string; unverified: string[] }) {
  // 长的在前：10.9.9.9 与 10.9.9.9:443 同时未溯源时整段标记（冒号不算实体的延续）
  const entities = unverified.filter(Boolean).sort((a, b) => b.length - a.length);
  if (entities.length === 0) return text;
  // 只匹配完整的实体：前后不紧接字母数字，也不以 . 或 - 连着字母数字（cam-02 不标 cam-02-1，10.9.9.9 不标 10.9.9.90）
  const alternatives = entities.map((e) => e.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const pattern = new RegExp(`(?<![A-Za-z0-9]|[A-Za-z0-9][.-])(${alternatives})(?![A-Za-z0-9]|[.-][A-Za-z0-9])`);
  return text.split(pattern).map((part, i) =>
    // split 带捕获组：奇数位是匹配到的实体
    i % 2 === 1 ? (
      <span key={i} title={UNVERIFIED} className="text-subtle-foreground underline decoration-dashed underline-offset-4">
        {part}
      </span>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    ),
  );
}
