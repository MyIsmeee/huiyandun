import type { Behavior, Target } from "../store/live";
import type { Camera } from "./devices";

/** 不确定半径超过此值时目标模型改为半透明（V-U1） */
export const HIGH_ERROR_M = 1;
/** 渲染时间轴落后于最新实测的时长：在相邻两次实测之间插值，不外推（FR-102） */
export const RENDER_DELAY_MS = 200;
/** 新目标被锁定时的扩散环时长（§5.1 L4） */
export const LOCK_RING_MS = 600;

export interface Visible extends Target {
  key: string;
  /** 跌倒或攀爬中：所属摄像头处于物理告警，且其最近一次行为事件指向此人 */
  alert: boolean;
  uncertain: boolean;
}

/** 场景中的目标：只投放已标定、已登记摄像头的目标（V-U2） */
export function visibleTargets(
  targets: Record<string, Target>,
  cameras: Camera[],
  behaviors: Record<string, Behavior>,
): Visible[] {
  const byId = new Map(cameras.map((c) => [c.id, c]));
  return Object.entries(targets).flatMap(([key, target]) => {
    const camera = byId.get(target.camera_id);
    if (!camera?.calibrated) return [];
    const physical = camera.state === "physical_alert" || camera.state === "both";
    const person = target.object_class === "person";
    const alert = person && physical && behaviors[target.camera_id]?.track_id === target.track_id;
    return [{ ...target, key, alert, uncertain: target.uncertainty_m > HIGH_ERROR_M }];
  });
}

/** 渲染时刻 t 的平面位置：在 t 两侧的实测位置之间线性插值；早于第一次实测取第一次，晚于最后一次取最后一次 */
export function positionAt(trail: Target["trail"], t: number): [number, number] {
  const i = trail.findIndex(([, , at]) => at >= t);
  const next = i === -1 ? undefined : trail[i];
  const prev = i > 0 ? trail[i - 1] : undefined;
  if (next && prev) {
    const k = (t - prev[2]) / (next[2] - prev[2]);
    return [prev[0] + (next[0] - prev[0]) * k, prev[1] + (next[1] - prev[1]) * k];
  }
  const [x, y] = next ?? trail.at(-1) ?? [0, 0];
  return [x, y];
}

/** 从 current 向 target 转动，最多 maxStep（弧度），取最短方向；车辆掉头时不瞬间翻转 */
export function turnToward(current: number, target: number, maxStep: number): number {
  const diff = Math.atan2(Math.sin(target - current), Math.cos(target - current));
  return current + Math.max(-maxStep, Math.min(maxStep, diff));
}

/** 视场不透明度：该摄像头当前有检出目标时提亮，随目标数增加（§5.1 L3），反映真实感知状态 */
export function coneOpacity(base: number, detecting: number): number {
  return detecting === 0 ? base : Math.min(0.28, 0.2 + 0.02 * (detecting - 1));
}
