import { create } from "zustand";
import type { Device, Site } from "../store/live";

export type Area = Site["areas"][number];

/** 态势页当前显示的区域（D-124）；null 表示尚未确定，由区域切换取排序后的第一个 */
export const useArea = create<{ areaId: string | null }>()(() => ({ areaId: null }));
export const showArea = (areaId: string) => useArea.setState({ areaId });

/** 一个区域中处于告警的设备数，按物理与网络分开（V-S3 以图标区分） */
export type AreaAlerts = { physical: number; cyber: number };

// 网络攻击未解除的状态都算：处置中与只能通知的同样仍是网络攻击色（ui.md §5.1）；已处置不算
const PHYSICAL: ReadonlySet<Device["state"]> = new Set(["physical_alert", "both"]);
const CYBER: ReadonlySet<Device["state"]> = new Set(["cyber_alert", "both", "pending_action", "notify_only"]);

/** 各区域告警中的设备数；没有告警的区域不在结果中 */
export function areaAlerts(devices: Device[]): Map<string, AreaAlerts> {
  const result = new Map<string, AreaAlerts>();
  for (const { state, camera } of devices) {
    const area = camera?.area_id;
    if (!area || (!PHYSICAL.has(state) && !CYBER.has(state))) continue;
    const counts = result.get(area) ?? { physical: 0, cyber: 0 };
    if (PHYSICAL.has(state)) counts.physical += 1;
    if (CYBER.has(state)) counts.cyber += 1;
    result.set(area, counts);
  }
  return result;
}

/** 区域切换的列表顺序（设计 150 §3）：有告警的区域置顶，其余保持原顺序 */
export function sortAreas(areas: Area[], alerts: Map<string, AreaAlerts>): Area[] {
  return [...areas.filter((a) => alerts.has(a.id)), ...areas.filter((a) => !alerts.has(a.id))];
}

/** 当前区域：所选区域仍存在时为它，否则为列表中的第一个（有告警的优先）；没有区域时为 null */
export function currentArea(areas: Area[], alerts: Map<string, AreaAlerts>, areaId: string | null): Area | null {
  return areas.find((a) => a.id === areaId) ?? sortAreas(areas, alerts)[0] ?? null;
}
