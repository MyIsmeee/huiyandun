import type { Alert, Device, Site, Target } from "../../store/live";
import { isPhysical } from "../../store/live";
import { STATUS } from "../../scene/devices";
import { DEVICE_STATE } from "../RelationGraph/model";
import { alertText, SEVERITY } from "../AlertList/AlertList";

/**
 * 态势大屏的数据整理（移植自 MF-TurbineMonitor 的七个面板，原项目为写死的演示数据，这里全部取自实时推送）。
 * 只做纯计算，便于单测；组件只负责取数与绘制
 */

type Area = Site["areas"][number];

/** 区域展开 / 收拢的时长（毫秒）：3D 按此推进，按钮在此期间不可用 */
export const EXPLODE_MS = 2200;
/** 告警巡检每台摄像头停留的时长（毫秒） */
export const PATROL_MS = 3500;

/** 告警的两类：网络（SecurityAlert）与物理（行为事件、轨迹规则事件） */
export type AlertKind = "cyber" | "physical";
export const alertKind = (alert: Alert): AlertKind => (isPhysical(alert) ? "physical" : "cyber");

const HOUR_MS = 3_600_000;

/** 近 hours 小时每小时的告警数，按网络与物理分开；最后一格为当前小时 */
export function hourlyTrend(alerts: Alert[], now: number, hours = 24) {
  const end = Math.floor(now / HOUR_MS) * HOUR_MS + HOUR_MS;
  const start = end - hours * HOUR_MS;
  const cyber = new Array<number>(hours).fill(0);
  const physical = new Array<number>(hours).fill(0);
  for (const alert of alerts) {
    const t = Date.parse(alert.ts);
    if (!(t >= start && t < end)) continue;
    const i = Math.floor((t - start) / HOUR_MS);
    const bucket = alertKind(alert) === "cyber" ? cyber : physical;
    bucket[i] = (bucket[i] ?? 0) + 1;
  }
  const labels = Array.from({ length: hours }, (_, i) => `${String(new Date(start + i * HOUR_MS).getHours()).padStart(2, "0")}时`);
  return { labels, cyber, physical };
}

/** 告警所在的设备：物理告警取摄像头，网络告警取目标设备（未登记时为 null） */
const alertDevice = (alert: Alert): string | null => ("camera_id" in alert ? alert.camera_id : alert.device_id);

/** 区域分布最多列出的区域数，其余并入"其他" */
export const MAX_AREAS = 5;

/**
 * 各区域的告警数（网络 / 物理）。所有区域都列出（没有告警为 0），按区域原顺序；
 * 设备不在任何区域或未登记的计入"未分区"；区域超过 MAX_AREAS 时告警最少的并入"其他"
 */
export function areaDistribution(alerts: Alert[], devices: Device[], areas: Area[]) {
  const areaOf = new Map(devices.map((d) => [d.id, d.camera?.area_id ?? null]));
  const rows = new Map<string, { name: string; cyber: number; physical: number }>(
    areas.map((a) => [a.id, { name: a.name, cyber: 0, physical: 0 }]),
  );
  const loose = { name: "未分区", cyber: 0, physical: 0 };
  for (const alert of alerts) {
    const id = alertDevice(alert);
    const area = id ? areaOf.get(id) : null;
    const row = (area && rows.get(area)) || loose;
    row[alertKind(alert)] += 1;
  }
  let list = [...rows.values()];
  if (list.length > MAX_AREAS) {
    const ranked = [...list].sort((a, b) => b.cyber + b.physical - (a.cyber + a.physical));
    const keep = new Set(ranked.slice(0, MAX_AREAS - 1));
    const other = { name: "其他", cyber: 0, physical: 0 };
    for (const row of ranked.slice(MAX_AREAS - 1)) {
      other.cyber += row.cyber;
      other.physical += row.physical;
    }
    list = [...list.filter((r) => keep.has(r)), other];
  }
  if (loose.cyber + loose.physical > 0) list.push(loose);
  return list;
}

/** 设备运行行的状态级别：决定左侧色条，文字始终给出状态名称（不只靠颜色） */
export type Tone = "ok" | "physical" | "cyber" | "muted" | "contained";

export const TONE_COLOR: Record<Tone, string> = {
  ok: "#74fabd",
  physical: STATUS.physical,
  cyber: STATUS.cyber,
  muted: STATUS.uncertain,
  contained: STATUS.contained,
};

export function deviceTone(state: Device["state"]): Tone {
  switch (state) {
    case "normal":
      return "ok";
    case "physical_alert":
      return "physical";
    case "cyber_alert":
    case "both":
    case "notify_only":
      return "cyber";
    case "pending_action":
    case "contained":
      return "contained";
    default:
      return "muted";
  }
}

/** 告警中排在前面：网络 > 物理 > 处置 > 离线等 > 正常，同级按名称 */
const TONE_ORDER: Record<Tone, number> = {
  cyber: 0,
  physical: 1,
  contained: 2,
  muted: 3,
  ok: 4,
};

export function deviceRows(devices: Device[]) {
  return devices
    .map((d) => ({
      id: d.id,
      name: d.name,
      state: DEVICE_STATE[d.state],
      tone: deviceTone(d.state),
      ip: d.ip,
    }))
    .sort((a, b) => TONE_ORDER[a.tone] - TONE_ORDER[b.tone] || a.name.localeCompare(b.name, "zh-CN"));
}

/** 事件流的一行：标题、设备名、等级（网络告警为严重度，物理告警为疑似 / 确认）、时刻 */
export function eventRows(alerts: Alert[], devices: Device[], limit = 30) {
  const names = new Map(devices.map((d) => [d.id, d.name]));
  return alerts.slice(0, limit).map((alert) => {
    const { title, device } = alertText(alert);
    const suspected = isPhysical(alert) && alert.level === "suspected";
    const level = "severity" in alert ? SEVERITY[alert.severity] : suspected ? "疑似" : "确认";
    const tone: Tone = !isPhysical(alert) ? "cyber" : suspected ? "muted" : "physical";
    return {
      id: alert.event_id,
      title,
      device: (device && names.get(device)) ?? device ?? "未登记设备",
      level,
      tone,
      at: Date.parse(alert.ts),
    };
  });
}

/** 大屏时刻格式：MM/DD HH:mm:ss（与原大屏一致） */
export function stamp(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 当前画面中的目标数，按人员与车辆（含自行车、摩托、公交、货车）分开 */
export function targetCounts(targets: Record<string, Target>) {
  let person = 0;
  let vehicle = 0;
  for (const t of Object.values(targets)) {
    if (t.object_class === "person") person += 1;
    else vehicle += 1;
  }
  return { person, vehicle };
}

/** 3D 中各区域的摆放：按网格排开，区域之间留 GAP_M，整体以原点为中心；x 为区域左上角，z 对应平面 y */
export const GAP_M = 6;

export interface Placed {
  id: string;
  name: string;
  x: number;
  z: number;
  width: number;
  depth: number;
}

export function layoutAreas(areas: Pick<Area, "id" | "name" | "width_m" | "depth_m">[]): {
  placed: Placed[];
  width: number;
  depth: number;
} {
  if (areas.length === 0) return { placed: [], width: 0, depth: 0 };
  const cols = Math.ceil(Math.sqrt(areas.length));
  const rows = Math.ceil(areas.length / cols);
  const colWidth = Array.from({ length: cols }, (_, c) => Math.max(0, ...areas.filter((_, i) => i % cols === c).map((a) => a.width_m)));
  const rowDepth = Array.from({ length: rows }, (_, r) =>
    Math.max(0, ...areas.filter((_, i) => Math.floor(i / cols) === r).map((a) => a.depth_m)),
  );
  const width = colWidth.reduce((s, w) => s + w, 0) + GAP_M * (cols - 1);
  const depth = rowDepth.reduce((s, d) => s + d, 0) + GAP_M * (rows - 1);
  const placed = areas.map((a, i) => {
    const [c, r] = [i % cols, Math.floor(i / cols)];
    const x = colWidth.slice(0, c).reduce((s, w) => s + w + GAP_M, 0) + ((colWidth[c] ?? 0) - a.width_m) / 2 - width / 2;
    const z = rowDepth.slice(0, r).reduce((s, d) => s + d + GAP_M, 0) + ((rowDepth[r] ?? 0) - a.depth_m) / 2 - depth / 2;
    return { id: a.id, name: a.name, x, z, width: a.width_m, depth: a.depth_m };
  });
  return { placed, width, depth };
}

/** 告警巡检的对象：处于告警或处置中的摄像头；没有时巡检全部已放置的摄像头 */
export function patrolList(devices: Device[]): {
  ids: string[];
  alerting: boolean;
} {
  const placed = devices.filter((d) => d.camera?.area_id);
  const alerting = placed.filter((d) => {
    const tone = deviceTone(d.state);
    return tone === "cyber" || tone === "physical" || d.state === "pending_action";
  });
  return alerting.length ? { ids: alerting.map((d) => d.id), alerting: true } : { ids: placed.map((d) => d.id), alerting: false };
}
