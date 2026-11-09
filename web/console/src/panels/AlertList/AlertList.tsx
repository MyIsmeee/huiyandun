import { ChevronDown, Clock, Cpu, PanelRightClose, Shield, ShieldAlert, TriangleAlert } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Item } from "@/components/ui/item";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import { type Alert, type Execution, type Incident, useLive } from "../../store/live";
import { select, useSelection } from "../../store/selection";
import { formatTime } from "../ConnectionStatus/ConnectionStatus";
import { TimelineDots } from "../IncidentTimeline/IncidentTimeline";

const BEHAVIOR: Record<string, string> = { fall: "跌倒", climb: "攀爬越界" };
// 告警等级以图标形状 + 文字区分，不以颜色深浅区分（V-S4）
export const SEVERITY: Record<Incident["severity"], string> = { critical: "严重", high: "高", medium: "中", low: "低" };
/** 关联事件的处置状态（ui.md §5.1）；无执行记录时为"未处置" */
const EXECUTION: Record<Execution["state"], string> = {
  pending: "待确认",
  executing: "处置中",
  verifying: "处置中",
  contained: "已处置",
  failed: "处置失败",
  rolled_back: "已解除",
  notify_only: "已通知 · 待联动",
  skipped: "未处置",
  expired: "未确认 · 已过期",
};

/** 告警的设备、标题、来源与可信度：行为事件按模型证据显示（D-069） */
function describe(alert: Alert) {
  if ("behavior" in alert) {
    return { device: alert.camera_id, title: BEHAVIOR[alert.behavior] ?? alert.behavior, model: true, confidence: alert.confidence_avg };
  }
  return { device: alert.device_id, title: alert.summary, model: alert.source === "model", confidence: alert.confidence };
}

/** 同一设备、同一类告警的合并间隔（D-106）：比组内最早一条晚不超过 5 分钟的并入该组 */
export const GROUP_GAP_MS = 5 * 60_000;

/** 合并后的一行：alerts 新的在前，至少一条 */
export interface AlertGroup {
  /** 组内最早一条的 event_id：新告警并入时不变，已展开的行不会自己收起 */
  id: string;
  alerts: [Alert, ...Alert[]];
}

/** 同类：行为事件按摄像头与行为，网络告警按设备、规则与来源 */
function kindOf(alert: Alert): string {
  if ("behavior" in alert) return `b/${alert.camera_id}/${alert.behavior}`;
  return `s/${alert.device_id ?? ""}/${alert.rule_id}/${alert.source}`;
}

/**
 * 合并同类告警（D-106）：输入新的在前；某条与同类最近一组的最早一条相隔不超过 GROUP_GAP_MS 即并入，
 * 否则另起一组。各组按其最新一条排列；不丢弃任何告警。
 */
export function groupAlerts(alerts: Alert[]): AlertGroup[] {
  const groups: AlertGroup[] = [];
  const latest = new Map<string, AlertGroup>();
  for (const alert of alerts) {
    const kind = kindOf(alert);
    const group = latest.get(kind);
    const oldest = group?.alerts[group.alerts.length - 1];
    if (group && oldest && Date.parse(oldest.ts) - Date.parse(alert.ts) <= GROUP_GAP_MS) {
      group.alerts.push(alert);
      group.id = alert.event_id;
      continue;
    }
    const created: AlertGroup = { id: alert.event_id, alerts: [alert] };
    groups.push(created);
    latest.set(kind, created);
  }
  return groups;
}

/** F 告警栏：数据取自推送 */
export function AlertList(props: { stale: boolean; lastFrameAt: number | null; onCollapse?: () => void }) {
  const alerts = useLive((s) => s.alerts);
  const incidents = useLive((s) => s.incidents);
  const executions = useLive((s) => s.executions);
  return <AlertListView alerts={alerts} incidents={incidents} executions={executions} {...props} />;
}

/** 告警栏视图筛选（D-112）：只过滤显示，不改变数据 */
type Filter = "all" | "physical" | "cyber";
const FILTERS: [Filter, string][] = [
  ["all", "全部"],
  ["physical", "物理"],
  ["cyber", "网络"],
];

/**
 * F 告警栏（D-077、D-112）：上方置顶关联事件及其处置状态与进度点，下方按时间倒序列出单条告警，同类合并为一行并显示次数，
 * 行尾展开（D-106）；规则来源为盾牌、模型来源为芯片并显示可信度（V-AI10、FR-206）；单击选中对应设备，
 * 选中的设备在列表中同步高亮（V-I3）；"全部 / 物理 / 网络"筛选只改变显示。
 * stale 为推送连接已断开：列表是断开前的内容，弱化显示并标注（UP-3、V-U3）。
 */
export function AlertListView(props: {
  alerts: Alert[];
  incidents: Incident[];
  executions: Record<string, Execution>;
  stale: boolean;
  lastFrameAt: number | null;
  /** 态势页可把告警卡收起为胶囊（设计 150 §3）；未传入时不显示收起按钮 */
  onCollapse?: () => void;
}) {
  const { alerts, incidents, executions, stale, lastFrameAt, onCollapse } = props;
  const selected = useSelection((s) => s.deviceId);
  const [filter, setFilter] = useState<Filter>("all");
  const groups = useMemo(() => groupAlerts(alerts), [alerts]);
  const shownGroups = filter === "all" ? groups : groups.filter((g) => "behavior" in g.alerts[0] === (filter === "physical"));
  const shownIncidents = filter === "physical" ? [] : incidents;
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  // M0 每个关联事件至多由一个 Playbook 处置（isolate-attacker）
  const stateOf = useMemo(() => {
    const byIncident = new Map(Object.values(executions).map((e) => [e.incident_id, e]));
    return (incident: Incident) => {
      const execution = byIncident.get(incident.id);
      return execution ? EXECUTION[execution.state] : "未处置";
    };
  }, [executions]);

  const empty = alerts.length === 0 && incidents.length === 0;
  return (
    <>
      <header className="flex h-11 shrink-0 items-center gap-2 border-b px-4">
        <h2 className="text-base font-medium">告警</h2>
        <span className="text-meta text-subtle-foreground tabular-nums">{incidents.length + groups.length}</span>
        <ToggleGroup
          type="single"
          size="sm"
          aria-label="筛选"
          value={filter}
          onValueChange={(value) => value && setFilter(value as Filter)}
          className="ml-auto"
        >
          {FILTERS.map(([value, label]) => (
            <ToggleGroupItem key={value} value={value} className="px-2.5 text-meta">
              {label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        {onCollapse && (
          <Button variant="ghost" size="icon" aria-label="收起告警" title="收起告警" onClick={onCollapse} className="-mr-2 size-8 text-muted-foreground">
            <PanelRightClose aria-hidden />
          </Button>
        )}
      </header>
      {stale && (
        <p className="flex items-center gap-1 border-b border-dashed border-uncertain px-4 py-2 text-xs text-muted-foreground">
          <Clock aria-hidden className="size-3.5" />
          数据非实时 · 最后更新 {formatTime(lastFrameAt)}
        </p>
      )}
      {empty || (shownIncidents.length === 0 && shownGroups.length === 0) ? (
        <Empty className="p-6">
          <EmptyHeader>
            <EmptyTitle className="text-sm">{empty ? "暂无告警" : "该类暂无告警"}</EmptyTitle>
            <EmptyDescription className="text-meta">最后更新 {formatTime(lastFrameAt)}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ScrollArea className={cn("min-h-0 flex-1 py-1", stale && "opacity-60")}>
          {shownIncidents.length > 0 && (
            <ul aria-label="关联事件" className="border-b pb-1">
              {shownIncidents.map((incident) => {
                const device = incident.device_ids[0] ?? null;
                return (
                  <li key={incident.id}>
                    <Row device={device} selected={device !== null && device === selected}>
                      <ShieldAlert aria-label="网络攻击" className="mx-0.5 mt-0.5 size-4 shrink-0 text-cyber" />
                      <span className="min-w-0 flex-1">
                        <span className="block font-medium break-words">{incident.title}</span>
                        <span className="block text-meta text-subtle-foreground tabular-nums">
                          {SEVERITY[incident.severity]} · {incident.device_ids.join("、")} ·{" "}
                          {formatTime(Date.parse(incident.created_at))}
                        </span>
                      </span>
                      <span className="flex shrink-0 flex-col items-end gap-1.5">
                        <span className="rounded-sm border px-1.5 py-0.5 text-xs text-muted-foreground">{stateOf(incident)}</span>
                        <TimelineDots incident={incident} />
                      </span>
                    </Row>
                  </li>
                );
              })}
            </ul>
          )}
          <ul aria-label="单条告警">
            {shownGroups.map((group) => {
              const [latest] = group.alerts;
              const count = group.alerts.length;
              const open = expanded.has(group.id);
              const label = open ? "收起" : `展开 ${count} 条`;
              return (
                <li key={group.id}>
                  <div className="flex items-start">
                    <AlertRow alert={latest} selected={selected} count={count} />
                    {/* 单条告警留出同宽空位，各行右侧的来源与可信度对齐 */}
                    {count === 1 && <span aria-hidden className="mr-2 w-7 shrink-0" />}
                    {count > 1 && (
                      <button
                        type="button"
                        aria-expanded={open}
                        aria-label={label}
                        title={label}
                        onClick={() => toggle(group.id)}
                        className="mt-1.5 mr-2 grid size-7 shrink-0 place-items-center rounded-md text-subtle-foreground transition-colors hover:bg-secondary hover:text-foreground"
                      >
                        <ChevronDown aria-hidden className={cn("size-4 transition-transform", open && "rotate-180")} />
                      </button>
                    )}
                  </div>
                  {open && (
                    <ul aria-label="合并的告警" className="ml-6 border-l animate-in fade-in">
                      {group.alerts.map((alert) => (
                        <li key={alert.event_id}>
                          <AlertRow alert={alert} selected={selected} count={1} />
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </ScrollArea>
      )}
    </>
  );
}

/** 一条告警或合并行；count > 1 时标出次数 */
function AlertRow(props: { alert: Alert; selected: string | null; count: number }) {
  const { alert, selected, count } = props;
  const { device, title, model, confidence } = describe(alert);
  const Source = model ? Cpu : Shield;
  return (
    <Row device={device} selected={device !== null && device === selected}>
      {"behavior" in alert ? (
        <TriangleAlert aria-label="物理告警" className="size-5 shrink-0 fill-physical text-foreground" />
      ) : (
        <ShieldAlert aria-label="网络攻击" className="mx-0.5 mt-0.5 size-4 shrink-0 text-cyber" />
      )}
      <span className="min-w-0 flex-1">
        <span className="block break-words">
          {title}
          {count > 1 && <span className="ml-1.5 text-xs font-medium text-muted-foreground tabular-nums">×{count}</span>}
        </span>
        <span className="block text-meta text-subtle-foreground tabular-nums">
          {device ?? "未登记设备"} · {count > 1 ? "最近 " : ""}
          {formatTime(Date.parse(alert.ts))}
        </span>
      </span>
      <span
        className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground tabular-nums"
        title={model ? "模型发现" : "规则发现"}
      >
        <Source aria-label={model ? "模型" : "规则"} className="size-3.5" />
        {model && `${Math.round(confidence * 100)}%`}
      </span>
    </Row>
  );
}

function Row(props: { device: string | null; selected: boolean; children: ReactNode }) {
  const { device, selected, children } = props;
  return (
    <Item asChild size="sm" className={cn("mx-1 min-w-0 flex-1 flex-nowrap items-start px-3 py-2 text-left hover:bg-secondary disabled:cursor-default", selected && "bg-accent hover:bg-accent")}>
      <button type="button" disabled={device === null} onClick={() => device && select(device)} aria-current={selected || undefined}>
        {children}
      </button>
    </Item>
  );
}
