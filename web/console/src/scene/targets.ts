import type { Behavior, Target, TargetClass } from "../store/live";
import type { Camera } from "./devices";
import type { View } from "./layout";

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

/** 各摄像头当前检出的目标数：每次推送统一算一次，各视场直接取用（§5.1 L3） */
export function detectingByCamera(targets: Record<string, Target>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const { camera_id } of Object.values(targets)) counts[camera_id] = (counts[camera_id] ?? 0) + 1;
  return counts;
}

/** 点缀蓝（V-S5）：只用于选中括框、胶囊标签与轨迹，不表达任何状态 */
export const ACCENT = "#2F6FE4";

export const CLASS_LABEL: Record<TargetClass, string> = {
  person: "人员",
  bicycle: "自行车",
  motorcycle: "摩托车",
  car: "轿车",
  bus: "公交",
  truck: "货车",
};

/** 速度换算为 km/h 取整；尚无速度（起步不足 3 帧）为 null（D-054） */
export const kmh = (speed_mps: number | null) => (speed_mps === null ? null : Math.round(speed_mps * 3.6));

/** 胶囊标签：类别 · 跟踪号 · 速度，尚无速度时不显示速度（§5.1 L5） */
export function targetLabel({ object_class, track_id, speed_mps }: Target): string {
  const speed = kmh(speed_mps);
  return [CLASS_LABEL[object_class], `#${track_id}`, ...(speed === null ? [] : [`${speed} km/h`])].join(" · ");
}

/** 点选命中的最小半径（像素）与各类目标的命中半径（米，约为模型半长）：命中区域不小于视觉尺寸（V-I4） */
const MIN_HIT_PX = 20;
const HIT_M: Record<TargetClass, number> = { person: 0.9, bicycle: 0.9, motorcycle: 1.1, car: 2.3, bus: 4, truck: 3.3 };

/** 单击命中的目标：在渲染时刻 t 的位置（模型中部）投影到视口，取命中半径内最近的一个；没有命中为 null */
export function pickTarget(list: Visible[], view: View, [px, py]: readonly [number, number], t: number): string | null {
  let best: { key: string; distance: number } | null = null;
  for (const target of list) {
    const [x, y] = positionAt(target.trail, t);
    const center = [x, 0.9, y] as const;
    const screen = view.project(center);
    if (!screen) continue;
    const distance = Math.hypot(screen[0] - px, screen[1] - py);
    const radius = Math.max(MIN_HIT_PX, HIT_M[target.object_class] * view.scale(center));
    if (distance <= radius && (!best || distance < best.distance)) best = { key: target.key, distance };
  }
  return best?.key ?? null;
}
