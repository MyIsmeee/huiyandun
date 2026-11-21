import { attackSources, containedSince } from "../../scene/attack";
import type { Alert, Device, Execution, Incident } from "../../store/live";

/**
 * 全局攻防态势（顶栏下的横幅与屏幕边缘告警）：
 * attack 正在被攻击 → confirm 待值班员确认处置 → defending AI 防护处置中 → contained 已阻断；
 * notified 为旁路模式只能通知、待联动（V-T1，不显示"已阻断"）
 */
export type Phase = "attack" | "confirm" | "defending" | "notified" | "contained";

export interface Threat {
  phase: Phase;
  /** 涉及的设备，处于该阶段的排在前面 */
  devices: Device[];
  incident: Incident | null;
  execution: Execution | null;
  /** 攻击源 IP */
  source: string | null;
  /** 攻击手法：关联事件标题，没有关联事件时取最近一条网络告警的摘要 */
  title: string;
  /** 发现攻击的时刻（毫秒）：命中路径中最早的告警，退回关联事件生成时刻、最近告警时刻 */
  startedAt: number | null;
  /** 处置生效的时刻（毫秒） */
  containedAt: number | null;
  /** AI 研判：未开始 / 调查中（已推送的步数）/ 已完成 */
  ai: { state: "none" | "running" | "done"; steps: number };
}

interface Live {
  devices: Record<string, Device>;
  alerts: Alert[];
  incidents: Incident[];
  executions: Record<string, Execution>;
  aiSeq: Record<string, number>;
  aiDone: Record<string, true>;
}

const PHASE_OF: Partial<Record<Device["state"], Phase>> = {
  cyber_alert: "attack",
  both: "attack",
  pending_action: "defending",
  notify_only: "notified",
  contained: "contained",
};
/** 多台设备处于不同阶段时，横幅显示最紧急的一个 */
const URGENCY: Phase[] = ["attack", "confirm", "defending", "notified", "contained"];

const isSecurity = (a: Alert): a is Extract<Alert, { src_ip: string }> => "src_ip" in a;

/** 当前的攻防态势；没有设备处于网络攻击或处置状态时为 null */
export function threatOf(live: Live, siteDevices: Device[]): Threat | null {
  const devices = siteDevices.map((d) => live.devices[d.id] ?? d);
  const engaged = devices.flatMap((d) => {
    const phase = PHASE_OF[d.state];
    return phase ? [{ device: d, phase }] : [];
  });
  if (engaged.length === 0) return null;

  // 执行按更新先后排列：倒序取最近一个
  const executions = Object.values(live.executions).reverse();
  const latestExecution = (deviceId: string) => executions.find((e) => e.device_ids.includes(deviceId)) ?? null;
  // 正在被攻击、而执行在等待值班员确认：须人工确认的处置（FR-407）
  const refined = engaged.map(({ device, phase }) =>
    phase === "attack" && latestExecution(device.id)?.state === "pending" ? { device, phase: "confirm" as Phase } : { device, phase },
  );
  const phase = URGENCY.find((p) => refined.some((e) => e.phase === p)) ?? "attack";
  const focus = refined.filter((e) => e.phase === phase).map((e) => e.device);
  const ordered = [...focus, ...refined.map((e) => e.device).filter((d) => !focus.includes(d))];
  const lead = focus[0] ?? ordered[0];
  if (!lead) return null;

  const incident = live.incidents.find((i) => i.status !== "closed" && i.device_ids.includes(lead.id)) ?? null;
  const execution = (incident && executions.find((e) => e.incident_id === incident.id)) ?? latestExecution(lead.id);
  const deviceAlerts = live.alerts.filter(isSecurity).filter((a) => a.device_id === lead.id);
  const hits = new Set(incident?.hit_path ?? []);
  const hitTimes = live.alerts.filter((a) => hits.has(a.event_id)).map((a) => Date.parse(a.ts));
  const latestAlert = deviceAlerts[0];
  const startedAt =
    hitTimes.length > 0
      ? Math.min(...hitTimes)
      : incident
        ? Date.parse(incident.created_at)
        : latestAlert
          ? Date.parse(latestAlert.ts)
          : null;
  const contained = phase === "contained" ? containedSince(lead.id, true, live.executions) : null;
  const aiDone = incident ? live.aiDone[incident.id] === true : false;
  const aiSteps = incident ? (live.aiSeq[incident.id] ?? 0) : 0;

  return {
    phase,
    devices: ordered,
    incident,
    execution,
    source: attackSources(live.alerts, live.incidents, live.executions).get(lead.id) ?? null,
    title: incident?.title ?? latestAlert?.summary ?? "网络攻击",
    startedAt,
    containedAt: contained,
    ai: { state: aiDone ? "done" : aiSteps > 0 ? "running" : "none", steps: aiSteps },
  };
}

/** 秒数的口语写法：12 秒、1 分 05 秒 */
export function durationText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} 秒`;
  return `${Math.floor(s / 60)} 分 ${String(s % 60).padStart(2, "0")} 秒`;
}
