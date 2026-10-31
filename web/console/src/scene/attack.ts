/** 平面坐标 [x, y]，单位米 */
type Point = readonly [number, number];

/** 外部攻击源标记在站点边缘之外的距离，单位米（D-076） */
export const OUTSIDE_M = 3;

/**
 * 攻击者只有 IP、没有位置（D-076）：取离设备最近的站点边缘，在其外侧 OUTSIDE_M 处放"外部攻击源"。
 * 站点为 [0, width] × [0, height] 的平面坐标，单位米。
 */
export function attackerAnchor([x, y]: Point, width: number, height: number): Point {
  const edges: [number, Point][] = [
    [x, [-OUTSIDE_M, y]],
    [width - x, [width + OUTSIDE_M, y]],
    [y, [x, -OUTSIDE_M]],
    [height - y, [x, height + OUTSIDE_M]],
  ];
  edges.sort((a, b) => a[0] - b[0]);
  return edges[0]?.[1] ?? [-OUTSIDE_M, y];
}

/** 设备处于这些状态时画攻击连线：网络攻击、处置中、只通知（04 §5.2） */
export const ATTACKED = new Set(["cyber_alert", "both", "pending_action", "notify_only"]);
