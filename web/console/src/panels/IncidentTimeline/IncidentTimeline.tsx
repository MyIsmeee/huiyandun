import { Bot, CircleCheck, Lock, ShieldAlert, TriangleAlert, Unlock } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { components } from "../../api/schema";
import { api, ApiError } from "../../lib/api";
import { useConnection } from "../../store/connection";
import { type Alert, type Execution, type Incident, MAX_INCIDENTS, useLive } from "../../store/live";
import { useSelection } from "../../store/selection";
import { formatStamp } from "../ConnectionStatus/ConnectionStatus";

type Investigation = components["schemas"]["Investigation"];
type Times = Partial<Record<Execution["state"], string>>;

/** 时间线节点：at 为毫秒时刻，未到达或时刻未知时为 null；note 为该节点的状态说明 */
export interface TimelineNode {
  key: "first" | "incident" | "ai" | "contained" | "released";
  label: string;
  at: number | null;
  reached: boolean;
  note: string | null;
}

const EXECUTION_NOTE: Partial<Record<Execution["state"], string>> = {
  pending: "待确认",
  executing: "处置中",
  verifying: "处置中",
  failed: "处置失败",
  notify_only: "已通知 · 待联动",
  skipped: "未处置",
  expired: "未确认 · 已过期",
};

const parse = (iso: string | null | undefined) => (iso ? Date.parse(iso) : null);

/** api-server 只调查这些等级的关联事件，且只调查创建后 10 分钟内收到的（investigator.py 的 SEVERITIES、STALE） */
const INVESTIGATED = new Set<Incident["severity"]>(["high", "critical"]);
const INVESTIGATE_WITHIN_MS = 10 * 60_000;
/** 调查排队等待的余量：调查器串行处理，排在后面的事件开始调查时可能已超过 10 分钟 */
const QUEUE_MARGIN_MS = 5 * 60_000;
/** 读取失败（非 404）后重试的间隔 */
export const RETRY_MS = 5_000;

/**
 * 尚无调查记录（404）时是否仍在等待调查：等级在调查范围内、且创建不久。调查记录在第一轮模型调用返回后才推送首帧，
 * 排队期间读到 404 不等于不调查
 */
export function awaitingInvestigation(incident: Pick<Incident, "severity" | "created_at">, now: number): boolean {
  return INVESTIGATED.has(incident.severity) && now - Date.parse(incident.created_at) < INVESTIGATE_WITHIN_MS + QUEUE_MARGIN_MS;
}

/**
 * 处置生效的时刻：执行器进入已处置时设 expires_at = 生效时刻 + ttl_s，之后的拦截证据补注、解封失败都不改它，
 * 刷新页面后由补推的最新状态同样能推出；没有 expires_at（从未生效）时取推送记下的首次时刻
 */
export function containedAt(execution: Execution | undefined, times: Times): number | null {
  if (execution?.expires_at) return Date.parse(execution.expires_at) - execution.ttl_s * 1000;
  return parse(times.contained);
}
/**
 * 关联事件的处置进程（FR-304、D-106）：首次告警 → 关联事件 → AI 判定 → 处置生效 → 解除。
 * 时刻全部取自系统事件：首次告警为命中路径中已收到的最早告警；处置与解除取执行事件的时刻（连接补推只含
 * 最新状态，刷新页面后已解除的执行不再知道生效时刻，如实显示为未知）。
 */
export function timelineOf(
  incident: Incident,
  alerts: Alert[],
  execution: Execution | undefined,
  times: Times,
  investigation: Investigation | null,
  /** 尚无调查记录但仍在等待调查（见 awaitingInvestigation） */
  awaiting = false,
): TimelineNode[] {
  const hits = new Set(incident.hit_path);
  const first = alerts.filter((a) => hits.has(a.event_id)).map((a) => Date.parse(a.ts));
  const firstAt = first.length > 0 ? Math.min(...first) : null;

  let ai: Pick<TimelineNode, "at" | "reached" | "note">;
  if (investigation?.verdict) {
    const { is_attack, confidence } = investigation.verdict;
    ai = {
      at: parse(investigation.finished_at),
      reached: true,
      note: `${is_attack ? "判定为攻击" : "判定为非攻击"} · ${Math.round(confidence * 100)}%`,
    };
  } else if (investigation?.error) {
    ai = { at: parse(investigation.finished_at), reached: true, note: "AI 研判不可用" };
  } else if (investigation) {
    ai = { at: null, reached: false, note: "调查中" };
  } else {
    ai = { at: null, reached: false, note: awaiting ? "等待调查" : "未调查" };
  }

  const effective = containedAt(execution, times);
  const released = execution?.state === "rolled_back";
  const contained = effective !== null || released;
  return [
    { key: "first", label: "首次告警", at: firstAt, reached: firstAt !== null, note: firstAt === null ? "已超出保留" : null },
    { key: "incident", label: "关联事件", at: Date.parse(incident.created_at), reached: true, note: null },
    { key: "ai", label: "AI 判定", ...ai },
    {
      key: "contained",
      label: "处置生效",
      at: effective,
      reached: contained,
      note: contained
        ? effective === null
          ? "时刻未知"
          : null
        : execution
          ? (EXECUTION_NOTE[execution.state] ?? null)
          : "未处置",
    },
    { key: "released", label: "解除", at: parse(times.rolled_back), reached: released, note: released ? null : "封禁中或未处置" },
  ];
}

/** 距首次告警的时长（ui.md §4）：小于 1 分钟按秒，小于 1 小时按分秒，否则按时分 */
export function formatOffset(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `+${s} 秒`;
  if (s < 3600) return `+${Math.floor(s / 60)} 分 ${s % 60} 秒`;
  return `+${Math.floor(s / 3600)} 小时 ${Math.floor((s % 3600) / 60)} 分`;
}

/** 选中设备最近一个关联事件；未选中时为全站最近一个（incidents 新的在前） */
export function pick(incidents: Incident[], deviceId: string | null): Incident | undefined {
  return deviceId ? incidents.find((i) => i.device_ids.includes(deviceId)) : incidents[0];
}

export type Phase = "unknown" | "running" | "done";

/**
 * 每个关联事件在每个调查阶段只读一次调查记录：告警栏各行的进度点与抽屉中的时间线共用，
 * 调查的中间步骤不改变"AI 判定"节点，不重读。ai 频道不在连接补推之内：每次连上（epoch 变化）后重读，
 * 断线期间结束或因服务重启中断的调查不会一直停在"调查中"；已结束的记录不再变化，不随重连重读。
 * 读取失败（非 404）不缓存，由调用方稍后重试
 */
const reads = new Map<string, { phase: Phase; epoch: number; final: boolean; result: Promise<Investigation> }>();
export function readInvestigation(id: string, phase: Phase, epoch = 0): Promise<Investigation> {
  const hit = reads.get(id);
  if (hit?.phase === phase && (hit.final || hit.epoch === epoch)) return hit.result;
  const result = api.getInvestigation(id);
  const entry = { phase, epoch, final: false, result };
  reads.delete(id); // 重新插入到末尾：按最近读取的先后淘汰
  reads.set(id, entry);
  // 页面最多保留 MAX_INCIDENTS 个关联事件，缓存同样只留最近读取的这么多个，长时间值班不增长
  for (const key of reads.keys()) {
    if (reads.size <= MAX_INCIDENTS) break;
    reads.delete(key);
  }
  result.then(
    (i) => {
      entry.final = i.finished_at !== null;
    },
    (e: unknown) => {
      if (!(e instanceof ApiError && e.status === 404) && reads.get(id)?.result === result) reads.delete(id);
    },
  );
  return result;
}

/** 关联事件的五个节点：调查记录在打开时、调查开始时与调查结束时、每次连上后读取；读取失败时 5 s 后重试 */
export function useTimeline(incident: Incident | undefined): TimelineNode[] | null {
  const alerts = useLive((s) => s.alerts);
  const executions = useLive((s) => s.executions);
  const executionTimes = useLive((s) => s.executionTimes);
  const phase = useLive((s): Phase => {
    if (!incident || s.aiSeq[incident.id] === undefined) return "unknown";
    return s.aiDone[incident.id] ? "done" : "running";
  });
  const epoch = useConnection((s) => s.epoch);
  // 记下读到的是哪个事件的调查：切换事件后不显示上一个事件的判定。404 时记下读到的时刻，据此判断是否仍在等待调查
  const [loaded, setLoaded] = useState<{ id: string; investigation: Investigation | null; at: number } | null>(null);
  const [retry, setRetry] = useState(0);

  const id = incident?.id;
  useEffect(() => {
    if (!id) return;
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    readInvestigation(id, phase, epoch).then(
      (investigation) => current && setLoaded({ id, investigation, at: Date.now() }),
      (e: unknown) => {
        if (!current) return;
        if (e instanceof ApiError && e.status === 404) setLoaded({ id, investigation: null, at: Date.now() });
        // 断线期间不重试：连上后 epoch 变化即重读
        else if (useConnection.getState().open) timer = setTimeout(() => setRetry((n) => n + 1), RETRY_MS);
      },
    );
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [id, phase, epoch, retry]);
  const record = loaded?.id === id ? loaded : null;
  const investigation = record?.investigation ?? null;
  const awaiting = !!incident && record !== null && record.investigation === null && awaitingInvestigation(incident, record.at);

  return useMemo(() => {
    if (!incident) return null;
    const execution = Object.values(executions)
      .filter((e) => e.incident_id === incident.id)
      .at(-1);
    return timelineOf(incident, alerts, execution, execution ? (executionTimes[execution.id] ?? {}) : {}, investigation, awaiting);
  }, [incident, alerts, executions, executionTimes, investigation, awaiting]);
}

/** 详情抽屉中的竖向处置时间线（ui.md §4、§8 IncidentTimeline）：选中设备最近一个关联事件 */
export function IncidentTimeline() {
  const deviceId = useSelection((s) => s.deviceId);
  const incident = useLive((s) => pick(s.incidents, deviceId));
  const nodes = useTimeline(incident);

  if (!incident || !nodes) return <p className="text-meta text-subtle-foreground">暂无关联事件</p>;
  const origin = nodes[0]?.at ?? Date.parse(incident.created_at);
  return (
    <div className="flex flex-col gap-3">
      <p className="text-meta text-muted-foreground">
        {incident.title}
        {incident.source_ip && <span className="font-mono"> · 来源 {incident.source_ip}</span>}
      </p>
      <ol aria-label="处置进程">
        {nodes.map((node, i) => (
          <Step key={node.key} node={node} origin={origin} last={i === nodes.length - 1} next={nodes[i + 1]?.reached ?? false} />
        ))}
      </ol>
    </div>
  );
}

/** 告警栏中关联事件行内的五个进度点（D-112）：实心为已到达，只用中性色 */
export function TimelineDots({ incident }: { incident: Incident }) {
  const nodes = useTimeline(incident);
  if (!nodes) return null;
  const reached = nodes.filter((n) => n.reached);
  const label = `处置进度 ${reached.length}/${nodes.length}：${reached.at(-1)?.label ?? "—"}`;
  return (
    <span role="img" aria-label={label} title={label} className="flex items-center gap-1">
      {nodes.map((node) => (
        <span
          key={node.key}
          className={`size-1.5 rounded-full ${node.reached ? "bg-foreground" : "border border-subtle-foreground"}`}
        />
      ))}
    </span>
  );
}

const ICON = { first: ShieldAlert, incident: TriangleAlert, ai: Bot, contained: Lock, released: Unlock } as const;

/** 节点的图标与色调：状态色只用于"首次告警"（网络攻击）与"处置生效"（已处置）的图标，并配文字（V-S3） */
export function nodeLook(node: TimelineNode) {
  const Icon = node.key === "contained" && node.reached ? CircleCheck : ICON[node.key];
  const tone = !node.reached
    ? "text-subtle-foreground"
    : node.key === "first"
      ? "text-cyber"
      : node.key === "contained"
        ? "text-contained"
        : "text-foreground";
  return { Icon, tone };
}

function Step(props: { node: TimelineNode; origin: number; last: boolean; next: boolean }) {
  const { node, origin, last, next } = props;
  const { Icon, tone } = nodeLook(node);
  const offset = node.at !== null && node.key !== "first" ? formatOffset(node.at - origin) : null;
  return (
    <li className="flex gap-3">
      <span className="flex flex-col items-center">
        <span
          className={`grid size-7 shrink-0 place-items-center rounded-full border ${node.reached ? "border-current" : "border-dashed border-border"} ${tone}`}
        >
          <Icon aria-hidden className="size-3.5" />
        </span>
        {!last && <span aria-hidden className={`my-1 w-px flex-1 ${next ? "bg-subtle-foreground" : "border-l border-dashed border-border"}`} />}
      </span>
      <span className={`flex min-w-0 flex-1 flex-col pb-4 ${last ? "pb-0" : ""}`}>
        <span className="flex items-baseline justify-between gap-2">
          <span className={`text-sm ${node.reached ? "font-medium" : "text-subtle-foreground"}`}>{node.label}</span>
          <span className="font-mono text-xs text-muted-foreground tabular-nums">{formatStamp(node.at)}</span>
        </span>
        {(offset || node.note) && (
          <span className="text-meta text-subtle-foreground">{[offset, node.note].filter(Boolean).join(" · ")}</span>
        )}
      </span>
    </li>
  );
}
