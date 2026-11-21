import { create } from "zustand";
import type { Incident } from "../../store/live";

/** 研判面板打开的关联事件；null 为收起 */
export const useSheet = create<{ incidentId: string | null }>(() => ({ incidentId: null }));

export const openInvestigation = (incidentId: string) => useSheet.setState({ incidentId });
export const closeInvestigation = () => useSheet.setState({ incidentId: null });

/** AI 值班员只调查 high 及以上的关联事件（investigator.SEVERITIES） */
export const INVESTIGATED = new Set<Incident["severity"]>(["high", "critical"]);
/** 只对此时长内生成的关联事件自动打开：登录后补推的近 24 小时记录不弹出 */
export const AUTO_OPEN_MS = 2 * 60_000;

/**
 * 新到达、应自动打开研判面板的关联事件：调查范围内、刚生成、此前没见过。同一攻击先后生成单域与跨域事件时取最新一起，
 * 面板跟着切到证据更全的跨域事件。seen 记录已处理过的事件编号（调用方持有，就地追加）
 */
export function autoOpenTarget(incidents: Incident[], seen: Set<string>, now: number): string | null {
  let target: string | null = null;
  // incidents 新的在前：倒序遍历，最后命中的即最新
  for (const incident of [...incidents].reverse()) {
    if (seen.has(incident.id)) continue;
    seen.add(incident.id);
    if (INVESTIGATED.has(incident.severity) && now - Date.parse(incident.created_at) <= AUTO_OPEN_MS) {
      target = incident.id;
    }
  }
  return target;
}
