import { Clock, Cpu, Shield, ShieldAlert, TriangleAlert } from "lucide-react";
import { useMemo } from "react";
import { type Alert, type Execution, type Incident, useLive } from "../../store/live";
import { select, useSelection } from "../../store/selection";
import { formatTime } from "../ConnectionStatus/ConnectionStatus";

const BEHAVIOR: Record<string, string> = { fall: "跌倒", climb: "攀爬越界" };
// 告警等级以图标形状 + 文字区分，不以颜色深浅区分（V-S4）
export const SEVERITY: Record<Incident["severity"], string> = { critical: "严重", high: "高", medium: "中", low: "低" };
/** 关联事件的处置状态（04 §5.2）；无执行记录时为"未处置" */
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

/** F 告警列表：数据取自推送 */
export function AlertList(props: { stale: boolean; lastFrameAt: number | null }) {
  const alerts = useLive((s) => s.alerts);
  const incidents = useLive((s) => s.incidents);
  const executions = useLive((s) => s.executions);
  return <AlertListView alerts={alerts} incidents={incidents} executions={executions} {...props} />;
}

/**
 * F 告警列表（D-077）：上方置顶关联事件及其处置状态，下方按时间倒序列出单条告警；规则来源为盾牌、
 * 模型来源为芯片并显示可信度（V-AI10、FR-206）；单击选中对应设备，选中的设备在列表中同步高亮（V-I3）。
 * stale 为推送连接已断开：列表是断开前的内容，弱化显示并标注（UP-3、V-U3）。
 */
export function AlertListView(props: {
  alerts: Alert[];
  incidents: Incident[];
  executions: Record<string, Execution>;
  stale: boolean;
  lastFrameAt: number | null;
}) {
  const { alerts, incidents, executions, stale, lastFrameAt } = props;
  const selected = useSelection((s) => s.deviceId);
  // M0 每个关联事件至多由一个 Playbook 处置（isolate-attacker）
  const stateOf = useMemo(() => {
    const byIncident = new Map(Object.values(executions).map((e) => [e.incident_id, e]));
    return (incident: Incident) => {
      const execution = byIncident.get(incident.id);
      return execution ? EXECUTION[execution.state] : "未处置";
    };
  }, [executions]);

  const banner = stale && (
    <p className="flex items-center gap-1 border-b border-dashed border-uncertain px-4 py-2 text-xs text-uncertain">
      <Clock aria-hidden className="size-3.5" />
      数据非实时 · 最后更新 {formatTime(lastFrameAt)}
    </p>
  );
  if (alerts.length === 0 && incidents.length === 0) {
    return (
      <>
        {banner}
        <div className="m-auto text-center text-sm text-fg-3">
          <p>暂无告警</p>
          <p className="mt-1">最后更新 {formatTime(lastFrameAt)}</p>
        </div>
      </>
    );
  }
  return (
    <>
      {banner}
      <div className={`min-h-0 flex-1 overflow-y-auto ${stale ? "opacity-60" : ""}`}>
        {incidents.length > 0 && (
          <ul aria-label="关联事件" className="border-b border-line">
            {incidents.map((incident) => {
              const device = incident.device_ids[0] ?? null;
              return (
                <li key={incident.id}>
                  <Row device={device} selected={device !== null && device === selected}>
                    <ShieldAlert aria-label="网络攻击" className="mt-0.5 size-4 shrink-0 text-cyber" />
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium break-words">{incident.title}</span>
                      <span className="block text-xs text-fg-3">
                        {SEVERITY[incident.severity]} · {incident.device_ids.join("、")} · {formatTime(Date.parse(incident.created_at))}
                      </span>
                    </span>
                    <span className="shrink-0 rounded-full border border-line px-2 py-0.5 text-xs">{stateOf(incident)}</span>
                  </Row>
                </li>
              );
            })}
          </ul>
        )}
        <ul aria-label="单条告警">
          {alerts.map((alert) => {
            const { device, title, model, confidence } = describe(alert);
            const Source = model ? Cpu : Shield;
            return (
              <li key={alert.event_id}>
                <Row device={device} selected={device !== null && device === selected}>
                  {"behavior" in alert ? (
                    <TriangleAlert aria-label="物理告警" className="mt-0.5 size-4 shrink-0 text-physical" />
                  ) : (
                    <ShieldAlert aria-label="网络攻击" className="mt-0.5 size-4 shrink-0 text-cyber" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block break-words">{title}</span>
                    <span className="block text-xs text-fg-3">
                      {device ?? "未登记设备"} · {formatTime(Date.parse(alert.ts))}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-1 text-xs text-fg-2" title={model ? "模型发现" : "规则发现"}>
                    <Source aria-label={model ? "模型" : "规则"} className="size-3.5" />
                    {model && `${Math.round(confidence * 100)}%`}
                  </span>
                </Row>
              </li>
            );
          })}
        </ul>
      </div>
    </>
  );
}

function Row(props: { device: string | null; selected: boolean; children: React.ReactNode }) {
  const { device, selected, children } = props;
  return (
    <button
      type="button"
      disabled={device === null}
      onClick={() => device && select(device)}
      aria-current={selected || undefined}
      className={`flex w-full items-start gap-2 px-4 py-2 text-left text-sm transition-colors hover:bg-raised disabled:cursor-default ${selected ? "bg-raised" : ""}`}
    >
      {children}
    </button>
  );
}
