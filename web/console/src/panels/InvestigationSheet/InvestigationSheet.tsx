import { Check, Circle, CircleAlert, Globe, House, LoaderCircle, Wrench, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { type Execution, type Incident, useLive } from "../../store/live";
import { type InvestigationLoad, TOOL_ICON, useInvestigation, VerdictCard } from "../AiInvestigation/AiInvestigation";
import { SEVERITY } from "../AlertList/AlertList";
import { formatStamp } from "../ConnectionStatus/ConnectionStatus";
import { autoOpenTarget, closeInvestigation, INVESTIGATED, openInvestigation, useSheet } from "./sheet";

/** 只读工具的中文名：评委与值班员看得懂每一步查了什么 */
export const TOOL_LABEL: Record<string, string> = {
  list_alerts: "查询告警",
  list_frame_events: "查询画面事件",
  get_device: "查询设备档案",
  query_sessions: "查询网络会话",
  get_baseline: "查询行为基线",
  lookup_technique: "查询 ATT&CK 技术",
};

type StageState = "done" | "active" | "waiting" | "warning";
interface Stage {
  label: string;
  state: StageState;
  detail: string;
}

/** 处置阶段：封禁由规则剧本执行，AI 不参与（G-03） */
function containStage(incident: Incident, execution: Execution | undefined): Stage {
  const label = "自动处置";
  if (!execution) {
    return incident.source_ip
      ? { label, state: "active", detail: "等待处置执行" }
      : { label, state: "done", detail: "无攻击源，不封禁" };
  }
  const { target, reason } = execution;
  switch (execution.state) {
    case "contained":
      return { label, state: "done", detail: `已封禁 ${target}` };
    case "executing":
    case "verifying":
      return { label, state: "active", detail: `正在封禁 ${target}` };
    case "pending":
      return { label, state: "active", detail: `待人工确认：封禁 ${target}` };
    case "notify_only":
      return { label, state: "done", detail: `旁路部署，已通知封禁 ${target}` };
    case "rolled_back":
      return { label, state: "done", detail: `已解除封禁 ${target}` };
    case "skipped":
      return { label, state: "done", detail: `未处置：${reason ?? "白名单地址"}` };
    case "expired":
      return { label, state: "warning", detail: "超时未确认，未处置" };
    case "failed":
      return { label, state: "warning", detail: `封禁失败${reason ? `：${reason}` : ""}` };
  }
}

const seconds = (from: string, to: number) => Math.max(0, Math.floor((to - Date.parse(from)) / 1000));

function investigateStage(incident: Incident, load: InvestigationLoad, now: number): Stage {
  const label = "AI 调查";
  if (!INVESTIGATED.has(incident.severity)) return { label, state: "done", detail: "等级低于高，不调查" };
  if (load.status !== "ready") return { label, state: "waiting", detail: load.status === "failed" ? "记录读取失败" : "排队等待" };
  const { steps, finished_at, started_at, error } = load.investigation;
  if (error) return { label, state: "warning", detail: `不可用：${error}` };
  if (finished_at === null) return { label, state: "active", detail: `第 ${steps.length + 1} 步 · 已用 ${seconds(started_at, now)} s` };
  return { label, state: "done", detail: `${steps.length} 步 · 用时 ${seconds(started_at, Date.parse(finished_at))} s` };
}

function verdictStage(load: InvestigationLoad): Stage {
  const verdict = load.status === "ready" ? load.investigation.verdict : null;
  if (!verdict) return { label: "结论", state: "waiting", detail: "尚无结论" };
  const percent = Math.round(verdict.confidence * 100);
  return { label: "结论", state: "done", detail: `${verdict.is_attack ? "判定为攻击" : "判定非攻击"} · ${percent}%` };
}

const STAGE_ICON: Record<StageState, typeof Check> = { done: Check, active: LoaderCircle, waiting: Circle, warning: CircleAlert };

/** 自动打开：新到达的高危关联事件（实时推送，不含登录后补推的旧记录）打开研判面板 */
export function InvestigationWatcher() {
  const incidents = useLive((s) => s.incidents);
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (seen.current === null) {
      // 首次渲染时已有的事件只记下、不弹出
      seen.current = new Set(incidents.map((i) => i.id));
      return;
    }
    const target = autoOpenTarget(incidents, seen.current, Date.now());
    if (target) openInvestigation(target);
  }, [incidents]);
  return null;
}

/** 研判面板（右侧覆盖层）：打开的关联事件从规则命中、自动处置、AI 逐步调查到结论的全过程 */
export function InvestigationSheet(props: { stale: boolean }) {
  const incidentId = useSheet((s) => s.incidentId);
  const incident = useLive((s) => s.incidents.find((i) => i.id === incidentId));
  useEffect(() => {
    if (!incidentId) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && closeInvestigation();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [incidentId]);
  if (!incident) return null;
  // key：换了事件即重新读取，不显示上一个事件的记录
  return <SheetState key={incident.id} incident={incident} stale={props.stale} />;
}

function SheetState(props: { incident: Incident; stale: boolean }) {
  const { incident, stale } = props;
  const execution = useLive((s) => {
    const mine = Object.values(s.executions).filter((e) => e.incident_id === incident.id);
    return mine[mine.length - 1];
  });
  const { load, now } = useInvestigation(incident, stale);
  return <InvestigationSheetView incident={incident} execution={execution} load={load} now={now} stale={stale} onClose={closeInvestigation} />;
}

export function InvestigationSheetView(props: {
  incident: Incident;
  execution: Execution | undefined;
  load: InvestigationLoad;
  now: number;
  stale: boolean;
  onClose: () => void;
}) {
  const { incident, execution, load, now, stale, onClose } = props;
  const stages: Stage[] = [
    { label: "规则命中", state: "done", detail: `${incident.rule_id} · ${formatStamp(Date.parse(incident.created_at), now)}` },
    containStage(incident, execution),
    investigateStage(incident, load, now),
    verdictStage(load),
  ];
  const investigation = load.status === "ready" ? load.investigation : null;
  const steps = investigation?.steps ?? [];
  const running = investigation !== null && investigation.finished_at === null && !investigation.error;
  const end = useRef<HTMLDivElement>(null);
  // 新的一步出现时滚到底部
  useEffect(() => {
    if (steps.length === 0) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    end.current?.scrollIntoView?.({ block: "end", behavior: reduce ? "auto" : "smooth" });
  }, [steps.length, investigation?.verdict]);

  return (
    <aside
      aria-label="事件研判"
      className="fixed top-12 right-0 bottom-0 z-30 flex w-[min(560px,100vw)] flex-col border-l bg-card shadow-lg motion-safe:animate-in motion-safe:slide-in-from-right-8 motion-safe:duration-200"
    >
      <header className="flex items-start gap-3 border-b px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold">事件研判</h2>
          <p className="mt-0.5 break-words">{incident.title}</p>
          <p className="text-meta text-muted-foreground tabular-nums">
            等级 {SEVERITY[incident.severity]} · 设备 {incident.device_ids.join("、")}
            {incident.source_ip && ` · 攻击源 ${incident.source_ip}`}
            {incident.techniques.length > 0 && ` · ${incident.techniques.join(" ")}`}
          </p>
        </div>
        <Button variant="ghost" size="icon" onClick={onClose} aria-label="关闭研判面板">
          <X aria-hidden />
        </Button>
      </header>

      <ol aria-label="处理流程" className="grid grid-cols-4 gap-2 border-b px-4 py-3">
        {stages.map((stage, i) => {
          const Icon = STAGE_ICON[stage.state];
          return (
            <li key={stage.label} className="flex min-w-0 flex-col gap-1" aria-current={stage.state === "active" ? "step" : undefined}>
              <span className="flex items-center gap-1.5 text-sm font-medium">
                <Icon
                  aria-hidden
                  className={cn(
                    "size-4 shrink-0",
                    stage.state === "done" && "text-primary",
                    stage.state === "active" && "motion-safe:animate-spin text-primary",
                    stage.state === "waiting" && "text-subtle-foreground",
                    stage.state === "warning" && "text-muted-foreground",
                  )}
                />
                {i + 1}. {stage.label}
              </span>
              <span className="text-meta break-words text-muted-foreground tabular-nums">{stage.detail}</span>
            </li>
          );
        })}
      </ol>

      <div className={cn("min-h-0 flex-1 overflow-y-auto px-4 py-3", stale && "opacity-60")}>
        {investigation?.provider && (
          <p className="mb-3 flex items-center gap-1.5 text-meta text-muted-foreground">
            {investigation.provider.location === "public" ? <Globe aria-hidden className="size-3.5" /> : <House aria-hidden className="size-3.5" />}
            调查模型 {investigation.provider.name}
            <span className="rounded-full border border-border px-2">
              {investigation.provider.location === "public" ? "公网 · 已脱敏" : "内网"}
            </span>
          </p>
        )}
        {steps.length === 0 && !investigation?.verdict && (
          <p className="text-muted-foreground">{investigation?.error ? `AI 调查不可用：${investigation.error}` : "等待 AI 开始调查…"}</p>
        )}
        <ol aria-label="调查步骤" className="flex flex-col gap-2">
          {steps.map((step, i) => {
            const Icon = TOOL_ICON[step.tool] ?? Wrench;
            return (
              <li key={i} className="rounded-lg border p-3 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-300">
                <p className="flex items-center gap-2 font-medium">
                  <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                  第 {i + 1} 步 · {TOOL_LABEL[step.tool] ?? step.tool}
                </p>
                <dl className="mt-2 grid grid-cols-[3em_1fr] gap-x-2 gap-y-1">
                  <dt className="text-muted-foreground">目的</dt>
                  <dd className="min-w-0 break-words">{step.reason}</dd>
                  <dt className="text-muted-foreground">查询</dt>
                  <dd className="min-w-0 font-mono text-xs leading-5 break-all">{step.args_summary}</dd>
                  <dt className="text-muted-foreground">结果</dt>
                  <dd className="min-w-0 break-words">{step.result_summary}</dd>
                </dl>
              </li>
            );
          })}
          {running && (
            <li className="flex items-center gap-2 rounded-lg border border-dashed p-3 text-muted-foreground">
              <LoaderCircle aria-hidden className="size-4 motion-safe:animate-spin" />第 {steps.length + 1} 步：正在选择下一项查询…
            </li>
          )}
        </ol>
        {investigation?.verdict && (
          <section aria-label="调查结论" className="mt-3 flex flex-col gap-2">
            <h3 className="font-medium">调查结论</h3>
            <VerdictCard verdict={investigation.verdict} />
          </section>
        )}
        <div ref={end} />
      </div>

      <footer className="border-t px-4 py-2 text-meta text-muted-foreground">
        AI 只做只读查询并给出结论，不执行任何处置；封禁由规则剧本执行，含模型证据的处置须人工确认。
      </footer>
    </aside>
  );
}
