import { Bot, CircleCheck, Lock, ShieldAlert, TriangleAlert, Unlock } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { components } from "../../api/schema";
import { api } from "../../lib/api";
import { type Alert, type Execution, type Incident, useLive } from "../../store/live";
import { useSelection } from "../../store/selection";
import { formatTime } from "../ConnectionStatus/ConnectionStatus";

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
    ai = { at: null, reached: false, note: "未调查" };
  }

  const containedAt = parse(times.contained);
  const released = execution?.state === "rolled_back";
  const contained = containedAt !== null || released;
  return [
    { key: "first", label: "首次告警", at: firstAt, reached: firstAt !== null, note: firstAt === null ? "已超出保留" : null },
    { key: "incident", label: "关联事件", at: Date.parse(incident.created_at), reached: true, note: null },
    { key: "ai", label: "AI 判定", ...ai },
    {
      key: "contained",
      label: "处置生效",
      at: containedAt,
      reached: contained,
      note: contained
        ? containedAt === null
          ? "时刻未知"
          : null
        : execution
          ? (EXECUTION_NOTE[execution.state] ?? null)
          : "未处置",
    },
    { key: "released", label: "解除", at: parse(times.rolled_back), reached: released, note: released ? null : "封禁中或未处置" },
  ];
}

/** 选中设备最近一个关联事件；未选中时为全站最近一个（incidents 新的在前） */
function pick(incidents: Incident[], deviceId: string | null): Incident | undefined {
  return deviceId ? incidents.find((i) => i.device_ids.includes(deviceId)) : incidents[0];
}

/** E 区处置时间线（HYD-UIX-004 §4.1、§8 IncidentTimeline） */
export function IncidentTimeline() {
  const deviceId = useSelection((s) => s.deviceId);
  const incident = useLive((s) => pick(s.incidents, deviceId));
  const alerts = useLive((s) => s.alerts);
  const executions = useLive((s) => s.executions);
  const executionTimes = useLive((s) => s.executionTimes);
  const seq = useLive((s) => (incident ? s.aiSeq[incident.id] : undefined));
  // 记下读到的是哪个事件的调查：切换事件后不显示上一个事件的判定
  const [loaded, setLoaded] = useState<Investigation | null>(null);

  const id = incident?.id;
  useEffect(() => {
    if (!id) return;
    let current = true;
    api.getInvestigation(id).then(
      (i) => current && setLoaded(i),
      () => undefined, // 未调查（404）或读取失败：节点显示"未调查"
    );
    return () => {
      current = false;
    };
  }, [id, seq]);
  const investigation = loaded?.incident_id === id ? loaded : null;

  const nodes = useMemo(() => {
    if (!incident) return null;
    const execution = Object.values(executions)
      .filter((e) => e.incident_id === incident.id)
      .at(-1);
    return timelineOf(incident, alerts, execution, execution ? (executionTimes[execution.id] ?? {}) : {}, investigation);
  }, [incident, alerts, executions, executionTimes, investigation]);

  if (!incident || !nodes) return <p className="m-auto text-sm text-fg-3">暂无关联事件</p>;
  const origin = nodes[0]?.at ?? Date.parse(incident.created_at);
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <p className="truncate text-sm text-fg-2">
        {incident.title} · {incident.device_ids.join("、")}
        {incident.source_ip && ` · 来源 ${incident.source_ip}`}
      </p>
      <ol aria-label="处置进程" className="flex flex-1 items-start">
        {nodes.map((node, i) => (
          <li key={node.key} className="flex min-w-0 flex-1 items-start">
            <Step node={node} origin={origin} />
            {i < nodes.length - 1 && (
              <span
                aria-hidden
                className={`mt-3 h-px min-w-4 flex-1 ${nodes[i + 1]?.reached ? "bg-fg-3" : "border-t border-dashed border-line"}`}
              />
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

const ICON = { first: ShieldAlert, incident: TriangleAlert, ai: Bot, contained: Lock, released: Unlock } as const;

function Step({ node, origin }: { node: TimelineNode; origin: number }) {
  const Icon = node.key === "contained" && node.reached ? CircleCheck : ICON[node.key];
  // 状态色只用于"首次告警"（网络攻击）与"处置生效"（已处置），并配图标与文字（V-S3）
  const tone =
    !node.reached ? "text-fg-3" : node.key === "first" ? "text-cyber" : node.key === "contained" ? "text-contained" : "text-fg";
  const offset = node.at !== null && node.key !== "first" ? `+${((node.at - origin) / 1000).toFixed(1)} s` : null;
  return (
    <div className="flex w-28 shrink-0 flex-col items-center gap-0.5 text-center">
      <span
        className={`grid size-7 place-items-center rounded-full border ${node.reached ? "border-current" : "border-dashed border-line"} ${tone}`}
      >
        <Icon aria-hidden className="size-4" />
      </span>
      <span className={`text-sm ${node.reached ? "font-semibold" : "text-fg-3"}`}>{node.label}</span>
      <span className="text-xs text-fg-2 tabular-nums">{node.at !== null ? formatTime(node.at) : "—"}</span>
      {offset && <span className="text-xs text-fg-3 tabular-nums">{offset}</span>}
      {node.note && <span className="text-xs text-fg-3">{node.note}</span>}
    </div>
  );
}
