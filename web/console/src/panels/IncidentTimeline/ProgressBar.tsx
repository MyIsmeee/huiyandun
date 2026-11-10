import { formatTime } from "../ConnectionStatus/ConnectionStatus";
import type { Device, Incident } from "../../store/live";
import { formatOffset, nodeLook, pick, type TimelineNode, useTimeline } from "./IncidentTimeline";

// 网络攻击未解除：告警中、处置中、已封禁（TTL 内）、只能通知；解除或告警到期后设备回到正常，事件不再算进行中（D-052）
const ONGOING: ReadonlySet<Device["state"]> = new Set(["cyber_alert", "both", "pending_action", "contained", "notify_only"]);

/**
 * 底部进度条显示的关联事件（设计 150 §3）：选中设备最近一个关联事件；未选中或该设备没有关联事件时，
 * 为最近一个进行中的（所涉设备仍处于网络攻击或封禁状态）；都没有时为 undefined，不显示
 */
export function progressIncident(incidents: Incident[], deviceId: string | null, devices: Device[]): Incident | undefined {
  const selected = deviceId ? pick(incidents, deviceId) : undefined;
  if (selected) return selected;
  const ongoing = new Set(devices.filter((d) => ONGOING.has(d.state)).map((d) => d.id));
  return incidents.find((i) => i.device_ids.some((id) => ongoing.has(id)));
}

/**
 * 处置进度条（设计 150 §3、FR-304、D-106）：首次告警 → 关联事件 → AI 判定 → 处置生效 → 解除，横向五节点，
 * 各节点显示时刻与距首次告警的时长；浮在态势页底部
 */
export function ProgressBar({ incident }: { incident: Incident }) {
  const nodes = useTimeline(incident);
  if (!nodes) return null;
  const origin = nodes[0]?.at ?? Date.parse(incident.created_at);
  return (
    <section aria-label="处置进度" className="floating-card pointer-events-auto flex w-full flex-col gap-2 px-4 py-3">
      <p className="truncate text-sm font-medium">
        {incident.title}
        {incident.source_ip && <span className="font-mono text-meta font-normal text-muted-foreground"> · 来源 {incident.source_ip}</span>}
      </p>
      <ol className="grid grid-cols-5 gap-2">
        {nodes.map((node, i) => (
          <Node key={node.key} node={node} origin={origin} reachedNext={nodes[i + 1]?.reached} />
        ))}
      </ol>
    </section>
  );
}

function Node(props: { node: TimelineNode; origin: number; reachedNext: boolean | undefined }) {
  const { node, origin, reachedNext } = props;
  const { Icon, tone } = nodeLook(node);
  const offset = node.at !== null && node.key !== "first" ? formatOffset(node.at - origin) : null;
  return (
    <li className="flex min-w-0 flex-col gap-1">
      <span className="flex items-center gap-2">
        <span
          className={`grid size-7 shrink-0 place-items-center rounded-full border ${node.reached ? "border-current" : "border-dashed border-border"} ${tone}`}
        >
          <Icon aria-hidden className="size-3.5" />
        </span>
        {reachedNext !== undefined && (
          <span aria-hidden className={`h-px flex-1 ${reachedNext ? "bg-subtle-foreground" : "border-t border-dashed border-border"}`} />
        )}
      </span>
      <span className={`truncate text-sm ${node.reached ? "font-medium" : "text-subtle-foreground"}`}>{node.label}</span>
      <span className="truncate font-mono text-xs text-muted-foreground tabular-nums">
        {node.at !== null ? formatTime(node.at) : "—"}
        {offset && <span className="font-sans text-subtle-foreground"> {offset}</span>}
      </span>
      {node.note && (
        <span title={node.note} className="truncate text-meta text-subtle-foreground">
          {node.note}
        </span>
      )}
    </li>
  );
}
