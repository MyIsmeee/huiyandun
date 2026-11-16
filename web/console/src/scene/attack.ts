import type { Alert, Execution, Incident } from "../store/live";
import type { Area } from "./layout";

/** 平面坐标 [x, y]，单位米 */
type Point = readonly [number, number];

/** 外部攻击源标记在当前区域边缘之外的距离，单位米（D-076） */
export const OUTSIDE_M = 3;

/**
 * 攻击者只有 IP、没有位置（D-076）：取离设备最近的当前区域边缘（设计 150 §9），在其外侧 OUTSIDE_M 处放"外部攻击源"。
 */
export function attackerAnchor([x, y]: Point, area: Area): Point {
  const [left, top] = [area.x0, area.y0];
  const [right, bottom] = [area.x0 + area.width_m, area.y0 + area.height_m];
  const edges: [number, Point][] = [
    [x - left, [left - OUTSIDE_M, y]],
    [right - x, [right + OUTSIDE_M, y]],
    [y - top, [x, top - OUTSIDE_M]],
    [bottom - y, [x, bottom + OUTSIDE_M]],
  ];
  edges.sort((a, b) => a[0] - b[0]);
  return edges[0]?.[1] ?? [left - OUTSIDE_M, y];
}

/** 设备处于这些状态时画攻击连线：网络攻击、处置中、只通知（ui.md §5.1） */
export const ATTACKED = new Set(["cyber_alert", "both", "pending_action", "notify_only"]);

/** 断开连线的淡出时长，与 theme.css 的 animate-fade-out 一致 */
export const FADE_MS = 1500;

/**
 * 各设备的外部攻击源 IP：取最近一条网络告警的源地址；告警已被列表上限挤出时，退回涉及该设备的最近关联事件的
 * 来源地址，再退回其处置执行的目标（隔离的即攻击源）。设备仍处于攻击或处置状态时连线不因告警滚出而消失
 */
export function attackSources(alerts: Alert[], incidents: Incident[], executions: Record<string, Execution>): Map<string, string> {
  const sources = new Map<string, string>();
  for (const a of alerts) if ("src_ip" in a && a.device_id && !sources.has(a.device_id)) sources.set(a.device_id, a.src_ip);
  for (const i of incidents) {
    if (!i.source_ip) continue;
    for (const id of i.device_ids) if (!sources.has(id)) sources.set(id, i.source_ip);
  }
  // 执行按更新先后排列：倒序取最近一个
  for (const e of Object.values(executions).reverse()) for (const id of e.device_ids) if (!sources.has(id)) sources.set(id, e.target);
  return sources;
}

/** 设备首次被看到处于已处置的时刻（本页会话内）：没有执行记录可查时据此计算淡出进度 */
const containedSeen = new Map<string, number>();

/**
 * 设备进入已处置的时刻（毫秒）；未处于已处置时为 null，并清除记录。优先取执行的生效时刻（到期时刻减封禁时长），
 * 刷新页面或重新挂载后仍是同一时刻；没有执行记录时取本页首次看到的时刻。断开连线的淡出按它计算进度，
 * 切页、切区域或攻击源锚点重新进入视野时不从头重播
 */
export function containedSince(deviceId: string, contained: boolean, executions: Record<string, Execution>, now = Date.now()): number | null {
  if (!contained) {
    containedSeen.delete(deviceId);
    return null;
  }
  const execution = Object.values(executions)
    .reverse()
    .find((e) => e.state === "contained" && e.device_ids.includes(deviceId) && e.expires_at);
  const effective = execution?.expires_at ? Date.parse(execution.expires_at) - execution.ttl_s * 1000 : Number.NaN;
  if (Number.isFinite(effective)) return effective;
  let seen = containedSeen.get(deviceId);
  if (seen === undefined) {
    seen = now;
    containedSeen.set(deviceId, seen);
  }
  return seen;
}

/**
 * 断开连线已淡出的时长（毫秒），未处于已处置时为 null。按当前时刻计算：组件在淡出中途重新挂载、或攻击源锚点离开视野
 * 后又回来时，元素以负的 animation-delay 接着播放剩余部分；播完后调用方不再画
 */
export function fadeElapsed(deviceId: string, contained: boolean, executions: Record<string, Execution>, now = Date.now()): number | null {
  const since = containedSince(deviceId, contained, executions, now);
  return since === null ? null : Math.max(0, now - since);
}
