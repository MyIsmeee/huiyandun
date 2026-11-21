import { ChevronDown, Clock, Cpu, PanelRightClose, Shield, ShieldAlert, TriangleAlert } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Item } from "@/components/ui/item";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import { useConnection } from "../../store/connection";
import { type Alert, type Execution, type Incident, isPhysical, isPhysicalIncident, useLive } from "../../store/live";
import { select, selectIncident, useSelection } from "../../store/selection";
import { formatStamp, formatTime } from "../ConnectionStatus/ConnectionStatus";
import { TimelineDots } from "../IncidentTimeline/IncidentTimeline";
import { ClearAll, DeleteButton } from "./Clear";
import { DisposeBar } from "./Dispose";

const BEHAVIOR: Record<string, string> = { fall: "跌倒", climb: "攀爬越界", still: "长时间静止", fight: "打架" };
/** 轨迹规则：类型与越线方向（forward 为沿线由起点走向终点时，从前进方向的右侧穿到左侧：平面俯视 y 向下，与箭头方向一致） */
const RULE: Record<string, string> = { intrusion: "区域入侵", line_crossing: "越线" };
const DIRECTION: Record<string, string> = { forward: "正向", backward: "反向" };
/** 疑似跌倒只在告警栏提示，不进入物理告警（TK-160）；确认后同组标题随最新一条变为"跌倒" */
const SUSPECTED: Record<string, string> = { fall: "疑似跌倒", still: "疑似长时间静止", fight: "疑似打架" };
// 告警等级以图标形状 + 文字区分，不以颜色深浅区分（V-S4）
export const SEVERITY: Record<Incident["severity"], string> = { critical: "严重", high: "高", medium: "中", low: "低" };
/** 关联事件的处置状态（ui.md §5.1）；无执行记录时为"未处置"，物理域事件不涉及封禁 */
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

/**
 * 自研网络规则的分类（rules/suricata/hyd-net.rules 的 hyd_category）：签名描述是英文原文（Suricata 的 msg），
 * 告警栏按分类给中文标题，原文放在悬停说明里；外部规则（ET Open 等）的分类不在其中，照原文显示
 */
const CATEGORY: Record<string, string> = { auth_bruteforce: "口令暴力破解", stream_hijack: "RTSP 推流劫持", log_tamper: "日志篡改" };

/** 告警的设备、标题、原文、来源与可信度：行为事件按模型证据显示（D-069） */
export function alertText(alert: Alert): { device: string | null; title: string; detail?: string; model: boolean; confidence: number } {
  if ("rule_type" in alert) {
    // 疑似：按安装参数估算的地面映射，或越线发生在遮挡中，只在告警栏提示
    const prefix = alert.level === "suspected" ? "疑似" : "";
    const direction = alert.direction ? `（${DIRECTION[alert.direction] ?? alert.direction}）` : "";
    return { device: alert.camera_id, title: `${prefix}${RULE[alert.rule_type] ?? alert.rule_type} · ${alert.rule_name}${direction}`, model: false, confidence: 1 };
  }
  if ("behavior" in alert) {
    const names = alert.level === "suspected" ? SUSPECTED : BEHAVIOR;
    return { device: alert.camera_id, title: names[alert.behavior] ?? alert.behavior, model: true, confidence: alert.confidence_avg };
  }
  const category = alert.source === "rule" ? CATEGORY[alert.category] : undefined;
  return category
    ? { device: alert.device_id, title: category, detail: `${alert.rule_id} · ${alert.summary}`, model: false, confidence: alert.confidence }
    : { device: alert.device_id, title: alert.summary, model: alert.source === "model", confidence: alert.confidence };
}

/** 同一设备、同一类告警的合并间隔（D-106）：比组内最早一条晚不超过 5 分钟的并入该组 */
export const GROUP_GAP_MS = 5 * 60_000;

/** 合并后的一行：alerts 新的在前，至少一条 */
export interface AlertGroup {
  /**
   * 行的稳定编号：沿用上一次分组时组内告警所属行的编号，没有时取组内最早一条的 event_id。新告警并入、
   * 最早的告警被 200 条上限挤出时都不变，已展开的行不会自己收起
   */
  id: string;
  alerts: [Alert, ...Alert[]];
}

/** 同类：行为事件按摄像头与行为，网络告警按设备、规则与来源 */
function kindOf(alert: Alert): string {
  if ("rule_type" in alert) return `r/${alert.camera_id}/${alert.rule_id}`;
  if ("behavior" in alert) return `b/${alert.camera_id}/${alert.behavior}`;
  return `s/${alert.device_id ?? ""}/${alert.rule_id}/${alert.source}`;
}

/**
 * 合并同类告警（D-106）：输入新的在前；某条与同类最近一组的最早一条相隔不超过 GROUP_GAP_MS 即并入，
 * 否则另起一组。各组按其最新一条排列；不丢弃任何告警。
 * previous 为上一次分组时各告警（event_id）所属行的编号，行的编号据此沿用（见 AlertGroup.id）
 */
export function groupAlerts(alerts: Alert[], previous: ReadonlyMap<string, string> = new Map()): AlertGroup[] {
  const groups: AlertGroup[] = [];
  const latest = new Map<string, AlertGroup>();
  for (const alert of alerts) {
    const kind = kindOf(alert);
    const group = latest.get(kind);
    const oldest = group?.alerts[group.alerts.length - 1];
    if (group && oldest && Date.parse(oldest.ts) - Date.parse(alert.ts) <= GROUP_GAP_MS) {
      group.alerts.push(alert);
      continue;
    }
    const created: AlertGroup = { id: alert.event_id, alerts: [alert] };
    groups.push(created);
    latest.set(kind, created);
  }
  // 从最早的告警找起：乱序到达的告警把两行连成一行时，沿用较早那一行的编号；编号不重复
  const used = new Set<string>();
  for (const group of groups) {
    const members = [...group.alerts].reverse();
    const id =
      members.map((a) => previous.get(a.event_id)).find((p) => p !== undefined && !used.has(p)) ??
      members.map((a) => a.event_id).find((e) => !used.has(e)) ??
      group.id;
    group.id = id;
    used.add(id);
  }
  return groups;
}

/** 上一次分组时各告警所属行的编号：告警栏各处共用，只与告警本身有关 */
let rowOf = new Map<string, string>();
/** 按上一次的分组沿用行编号地合并告警 */
function stableGroups(alerts: Alert[]): AlertGroup[] {
  const groups = groupAlerts(alerts, rowOf);
  rowOf = new Map(groups.flatMap((g) => g.alerts.map((a) => [a.event_id, g.id] as const)));
  return groups;
}

/** F 告警栏：数据取自推送 */
export function AlertList(props: { stale: boolean; lastFrameAt: number | null; onCollapse?: () => void }) {
  const alerts = useLive((s) => s.alerts);
  const incidents = useLive((s) => s.incidents);
  const executions = useLive((s) => s.executions);
  const synced = useConnection((s) => s.synced);
  return <AlertListView alerts={alerts} incidents={incidents} executions={executions} loading={!synced} {...props} />;
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
  /** 本次登录后尚未收到推送：连上后先补推近 24 小时的记录，此前为空不等于没有告警 */
  loading?: boolean;
  /** 态势页可把告警卡收起为胶囊（设计 150 §3）；未传入时不显示收起按钮 */
  onCollapse?: () => void;
}) {
  const { alerts, incidents, executions, stale, lastFrameAt, loading = false, onCollapse } = props;
  const selected = useSelection((s) => s.deviceId);
  const selectedIncident = useSelection((s) => s.incidentId);
  const [filter, setFilter] = useState<Filter>("all");
  const groups = useMemo(() => stableGroups(alerts), [alerts]);
  const shownGroups = filter === "all" ? groups : groups.filter((g) => isPhysical(g.alerts[0]) === (filter === "physical"));
  const shownIncidents = filter === "all" ? incidents : incidents.filter((i) => isPhysicalIncident(i) === (filter === "physical"));
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  // 每个关联事件至多由一个 Playbook 执行：本机防火墙与外部防火墙联动按部署模式二选一（FR-1001）
  const stateOf = useMemo(() => {
    const byIncident = new Map(Object.values(executions).map((e) => [e.incident_id, e]));
    return (incident: Incident) => {
      const execution = byIncident.get(incident.id);
      if (execution) return EXECUTION[execution.state];
      return isPhysicalIncident(incident) ? "无需封禁" : "未处置";
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
        <ClearAll
          eventIds={shownGroups.flatMap((g) => g.alerts.map((a) => a.event_id))}
          incidentIds={shownIncidents.map((i) => i.id)}
          count={shownIncidents.length + shownGroups.reduce((n, g) => n + g.alerts.length, 0)}
        />
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
            <EmptyTitle className="text-sm">
              {!empty ? "该类暂无告警" : !loading ? "暂无告警" : stale ? "未能载入告警" : "正在载入告警…"}
            </EmptyTitle>
            {/* 载入中还没有收到任何推送："最后更新"无从谈起 */}
            {!(empty && loading && !stale) && <EmptyDescription className="text-meta">最后更新 {formatTime(lastFrameAt)}</EmptyDescription>}
          </EmptyHeader>
        </Empty>
      ) : (
        <ScrollArea className={cn("min-h-0 flex-1 py-1", stale && "opacity-60")}>
          {shownIncidents.length > 0 && (
            <ul aria-label="关联事件" className="border-b pb-1">
              {shownIncidents.map((incident) => {
                const device = incident.device_ids[0] ?? null;
                // 点选的那一起高亮；只选了设备时高亮该设备最近的一起（详情面板显示的就是它）
                const current =
                  selectedIncident !== null
                    ? selectedIncident === incident.id
                    : device !== null && device === selected && incidents.find((i) => i.device_ids.includes(device)) === incident;
                return (
                  <li key={incident.id} className="flex items-start">
                    <Row device={device} selected={current} onSelect={() => selectIncident(incident)}>
                      {isPhysicalIncident(incident) ? (
                        <TriangleAlert aria-label="物理告警" className="size-5 shrink-0 fill-physical text-foreground" />
                      ) : (
                        <ShieldAlert aria-label="网络攻击" className="mx-0.5 mt-0.5 size-4 shrink-0 text-cyber" />
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="block font-medium break-words">{incident.title}</span>
                        <span className="block text-meta text-subtle-foreground tabular-nums">
                          {SEVERITY[incident.severity]} · {incident.device_ids.join("、")} ·{" "}
                          {formatStamp(Date.parse(incident.created_at))}
                        </span>
                      </span>
                      <span className="flex shrink-0 flex-col items-end gap-1.5">
                        <span className="rounded-sm border px-1.5 py-0.5 text-xs text-muted-foreground">{stateOf(incident)}</span>
                        <TimelineDots incident={incident} />
                      </span>
                    </Row>
                    <DeleteButton label="删除该关联事件" eventIds={[]} incidentIds={[incident.id]} />
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
                    <DeleteButton label={count > 1 ? `删除这 ${count} 条告警` : "删除该告警"} eventIds={group.alerts.map((a) => a.event_id)} />
                  </div>
                  {/* 物理告警与网络告警都可处置：已确认、误报、已处理（告警闭环） */}
                  <DisposeBar alerts={group.alerts} className="mb-1.5 ml-12 mr-3" />
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

/** 平台自身遭受的攻击（HYD-WEB-*，如控制台登录爆破）：目标是平台而不是摄像头，不按未登记设备显示 */
function isPlatform(alert: Alert): boolean {
  return "rule_id" in alert && alert.rule_id.startsWith("HYD-WEB-");
}

/** 目标未登记为设备的网络告警（FR-203）：标出被攻击的地址，否则无从得知哪台主机遭攻击 */
export function unregistered(alert: Alert): string {
  const name = isPlatform(alert) ? "管理平台" : "未登记设备";
  return "dst_ip" in alert ? `${name} ${alert.dst_ip}` : name;
}

/** 一条告警或合并行；count > 1 时标出次数 */
function AlertRow(props: { alert: Alert; selected: string | null; count: number }) {
  const { alert, selected, count } = props;
  const { device, title, detail, model, confidence } = alertText(alert);
  const Source = model ? Cpu : Shield;
  return (
    <Row device={device} selected={device !== null && device === selected}>
      {isPhysical(alert) ? (
        <TriangleAlert aria-label="物理告警" className="size-5 shrink-0 fill-physical text-foreground" />
      ) : (
        <ShieldAlert aria-label="网络攻击" className="mx-0.5 mt-0.5 size-4 shrink-0 text-cyber" />
      )}
      <span className="min-w-0 flex-1">
        <span className="block break-words" title={detail}>
          {title}
          {count > 1 && <span className="ml-1.5 text-xs font-medium text-muted-foreground tabular-nums">×{count}</span>}
        </span>
        <span
          className="block text-meta text-subtle-foreground tabular-nums"
          title={
            device !== null
              ? undefined
              : isPlatform(alert)
                ? "管理平台自身遭攻击：请核查来源地址，告警不自动处置"
                : "目标地址未登记为摄像头：告警不关联成事件、不自动处置，登记后纳入防护"
          }
        >
          {device ?? unregistered(alert)} · {count > 1 ? "最近 " : ""}
          {formatStamp(Date.parse(alert.ts))}
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

function Row(props: { device: string | null; selected: boolean; onSelect?: () => void; children: ReactNode }) {
  const { device, selected, onSelect, children } = props;
  return (
    <Item asChild size="sm" className={cn("mx-1 min-w-0 flex-1 flex-nowrap items-start px-3 py-2 text-left hover:bg-secondary disabled:cursor-default", selected && "bg-accent hover:bg-accent")}>
      <button type="button" disabled={device === null} onClick={() => device && (onSelect ? onSelect() : select(device))} aria-current={selected || undefined}>
        {children}
      </button>
    </Item>
  );
}
