import type { Area } from "./layout";

/** 平面坐标 [x, y]，单位米 */
type Point = readonly [number, number];

/** 外部攻击源标记在覆盖范围边缘之外的距离，单位米（D-076） */
export const OUTSIDE_M = 3;

/**
 * 攻击者只有 IP、没有位置（D-076）：取离设备最近的覆盖范围边缘（D-116），在其外侧 OUTSIDE_M 处放"外部攻击源"。
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

/** 设备处于这些状态时画攻击连线：网络攻击、处置中、只通知（04 §5.2） */
export const ATTACKED = new Set(["cyber_alert", "both", "pending_action", "notify_only"]);
