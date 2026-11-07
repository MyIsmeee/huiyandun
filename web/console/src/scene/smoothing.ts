import { OneEuroFilter } from "1eurofilter";
import type { Target } from "../store/live";
import { positionAt } from "./targets";

/**
 * 场景运动平滑（04 V-A7、V-A8）：检测原始值不直接上屏。每次实测到达时以一欧元滤波（Casiez 2012，作者发布的实现）
 * 处理位置、朝向、关键点与检测框——静止时强平滑、快速移动时滞后小；渲染时在滤波后的相邻两次实测之间插值。
 * 滤波输出落在已收到的实测之间，不外推（FR-102）。
 */

/** 自适应渲染延迟的上下限（V-A7） */
export const DELAY_MIN_MS = 150;
export const DELAY_MAX_MS = 400;
/** 尚无足够间隔可估时的渲染延迟 */
const DELAY_DEFAULT_MS = 250;
/** 关键点可见性滞回（V-A8）：≥ 0.3 转可见、< 0.2 转不可见；0.3 与 pose.ts 的 KEYPOINT_MIN 一致 */
const SHOW_SCORE = 0.3;
const HIDE_SCORE = 0.2;

/**
 * 一欧元滤波参数 [最小截止频率 Hz, β, 导数截止频率 Hz]，按实测间隔约 125 ms 调定（V-P4 单元测试）：
 * 平面位置以米计；画面坐标为归一化值，同样的运动在画面上约小一个数量级，β 相应放大
 */
const POSITION = [0.1, 1, 0.3] as const;
const HEADING = [0.3, 0.5, 0.3] as const;
const IMAGE = [0.3, 10, 0.3] as const;

const filter = ([minCutoff, beta, dCutoff]: readonly [number, number, number]) =>
  new OneEuroFilter(8, minCutoff, beta, dCutoff);

/**
 * 渲染延迟：该目标最近 10 次实测到达间隔中位数的 1.5 倍，限定在 150～400 ms（V-A7）。
 * 固定延迟在检测间隔接近或超过它时，会走到最后一个实测点停住、新点到达再跳过去
 */
export function renderDelay(trail: Target["trail"]): number {
  const recent = trail.slice(-11);
  const gaps = recent.slice(1).map(([, , t], i) => t - (recent[i]?.[2] ?? t));
  if (gaps.length === 0) return DELAY_DEFAULT_MS;
  gaps.sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)] ?? DELAY_DEFAULT_MS;
  return Math.min(DELAY_MAX_MS, Math.max(DELAY_MIN_MS, 1.5 * median));
}

/** 姿态：关键点与检测框（画面归一化），关键点的分数已按滞回化为 1（可见）或 0（不可见） */
export interface Pose {
  keypoints: Target["keypoints"];
  bbox: Target["bbox"];
}

interface PoseSample extends Pose {
  at: number;
}

interface Point {
  u: OneEuroFilter;
  v: OneEuroFilter;
  visible: boolean;
  last: [number, number] | null;
}

/** 一个目标的平滑状态（由 TargetModels 按目标保存） */
export class TargetSmoother {
  private readonly x = filter(POSITION);
  private readonly y = filter(POSITION);
  private readonly heading = filter(HEADING);
  private headingIn: number | null = null;
  private readonly box = [0, 1, 2, 3].map(() => filter(IMAGE));
  private readonly points: Point[] = [];
  private previous: PoseSample | null = null;
  private current: PoseSample | null = null;
  /** 滤波后的轨迹 [x, y, 到达时刻]，与 Target.trail 一一对应 */
  trail: [number, number, number][] = [];
  /** 滤波后的朝向（弧度，已展开）；尚无朝向时为 null */
  angle: number | null = null;

  /** 跟上目标的实测：只处理比已处理的更新的轨迹点，并丢弃已移出轨迹时间窗的点 */
  update(target: Pick<Target, "trail" | "heading_deg" | "keypoints" | "bbox">): void {
    const since = this.trail.at(-1)?.[2] ?? Number.NEGATIVE_INFINITY;
    const fresh = target.trail.filter(([, , at]) => at > since);
    for (const [x, y, at] of fresh) this.trail.push([this.x.filter(x, at / 1000), this.y.filter(y, at / 1000), at]);
    const oldest = target.trail[0]?.[2] ?? Number.POSITIVE_INFINITY;
    this.trail = this.trail.filter(([, , at]) => at >= oldest);
    const at = fresh.at(-1)?.[2];
    if (at === undefined) return;
    if (target.heading_deg !== null) this.turn((-target.heading_deg * Math.PI) / 180, at);
    this.pushPose(target, at);
  }

  /** 渲染时刻 t 的平面位置：在滤波后的相邻两次实测之间插值 */
  position(t: number): [number, number] {
    return positionAt(this.trail, t);
  }

  /** 朝向展开到上一次输入附近再滤波，避免 ±π 处跳变 */
  private turn(angle: number, at: number): void {
    const unwrapped =
      this.headingIn === null ? angle : this.headingIn + Math.atan2(Math.sin(angle - this.headingIn), Math.cos(angle - this.headingIn));
    this.headingIn = unwrapped;
    this.angle = this.heading.filter(unwrapped, at / 1000);
  }

  /** 关键点按序号滤波并做可见性滞回，检测框同样滤波（V-A8） */
  private pushPose({ keypoints, bbox }: Pose, at: number): void {
    const t = at / 1000;
    const box = bbox.map((value, i) => this.box[i]?.filter(value, t) ?? value);
    const points =
      keypoints?.map(([u = 0, v = 0, score = 0], i) => {
        const point = (this.points[i] ??= { u: filter(IMAGE), v: filter(IMAGE), visible: false, last: null });
        point.visible = point.visible ? score >= HIDE_SCORE : score >= SHOW_SCORE;
        // 低分的点位置不可信：不送进滤波，沿用上一次的位置（此时已不可见，只在补全时被替换）
        if (score < HIDE_SCORE && point.last) return [...point.last, 0];
        point.last = [point.u.filter(u, t), point.v.filter(v, t)];
        return [...point.last, point.visible ? 1 : 0];
      }) ?? null;
    this.previous = this.current;
    this.current = { keypoints: points, bbox: box, at };
  }

  /** 渲染时刻 t 的姿态：在前后两次实测之间插值；可见性取较近的一次 */
  pose(t: number): Pose | null {
    const { previous, current } = this;
    if (!current) return null;
    if (!previous || t >= current.at) return current;
    const k = Math.max(0, Math.min(1, (t - previous.at) / (current.at - previous.at || 1)));
    const lerp = (a: number, b: number) => a + (b - a) * k;
    const near = k < 0.5 ? previous : current;
    return {
      bbox: current.bbox.map((b, i) => lerp(previous.bbox[i] ?? b, b)),
      keypoints:
        current.keypoints && previous.keypoints
          ? current.keypoints.map(([u = 0, v = 0], i) => {
              const [pu = u, pv = v] = previous.keypoints?.[i] ?? [];
              return [lerp(pu, u), lerp(pv, v), near.keypoints?.[i]?.[2] ?? 0];
            })
          : current.keypoints,
    };
  }
}

/** 各目标的平滑状态：TargetModels 逐帧更新；跟随视角与点选按画面上看到的位置取 */
export const smoothers = new Map<string, TargetSmoother>();

/** 取（或建立）目标的平滑状态并跟上最新实测 */
export function smoothed(key: string, target: Target): TargetSmoother {
  let smoother = smoothers.get(key);
  if (!smoother) {
    smoother = new TargetSmoother();
    smoothers.set(key, smoother);
  }
  smoother.update(target);
  return smoother;
}

/** 渲染时刻：降低动效时直接取最新（V-A4），否则落后自适应延迟 */
export function renderTime(target: Pick<Target, "trail">, now: number, motion: boolean): number {
  return motion ? now - renderDelay(target.trail) : Number.POSITIVE_INFINITY;
}

/** 目标在画面上的平面位置：已有平滑状态时取平滑后的，否则按原始轨迹插值 */
export function renderedPosition(key: string, target: Target, now: number, motion: boolean): [number, number] {
  const t = renderTime(target, now, motion);
  return smoothers.get(key)?.position(t) ?? positionAt(target.trail, t);
}

/** 目标消失后释放其平滑状态 */
export function forget(alive: ReadonlySet<string>): void {
  for (const key of smoothers.keys()) if (!alive.has(key)) smoothers.delete(key);
}
