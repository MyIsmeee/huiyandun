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
/** 姿态队列的条数上限：正常只保留最大渲染延迟内的实测（8～30 FPS 下 4～13 条），推送异常密集时仍有界 */
const POSE_QUEUE_MAX = 64;
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

/** 一个目标的平滑状态（按目标保存在 smoothers 中） */
export class TargetSmoother {
  private readonly x = filter(POSITION);
  private readonly y = filter(POSITION);
  private readonly heading = filter(HEADING);
  private headingIn: number | null = null;
  private readonly box = [0, 1, 2, 3].map(() => filter(IMAGE));
  private readonly points: Point[] = [];
  /**
   * 近期各次实测的滤波后姿态，按时刻先后。渲染时刻落后最新实测一个渲染延迟（至多 DELAY_MAX_MS），
   * 只留最近两次时它有一半时间早于前一次，姿态先冻结、新实测到达再跳半步：保留到能包住最早的渲染时刻为止
   */
  private poses: PoseSample[] = [];
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
    this.poses.push({ keypoints: points, bbox: box, at });
    // 渲染时刻不早于最新实测减 DELAY_MAX_MS：其前只需再留一条，供两者之间插值
    const oldest = at - DELAY_MAX_MS;
    let drop = Math.max(0, this.poses.length - POSE_QUEUE_MAX);
    while (drop < this.poses.length - 1 && (this.poses[drop + 1]?.at ?? at) <= oldest) drop += 1;
    if (drop > 0) this.poses.splice(0, drop);
  }

  /**
   * 渲染时刻 t 的姿态：在包住 t 的前后两次实测之间插值，与位置同一渲染时间轴；可见性取较近的一次。
   * 晚于最新一次取最新，早于最早一次取最早，不外推
   */
  pose(t: number): Pose | null {
    const { poses } = this;
    const last = poses.at(-1);
    if (!last) return null;
    if (t >= last.at) return last;
    const next = poses.findIndex(({ at }) => at >= t);
    const [previous, current] = [poses[next - 1], poses[next]];
    if (!current) return last;
    if (!previous) return current;
    const k = (t - previous.at) / (current.at - previous.at || 1);
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

/**
 * 各目标的平滑状态，由多个使用者共用：3D 场景（TargetModels）、2D 视图与各路画面叠加（DetectionOverlay）取同一份滤波结果；
 * 跟随视角与点选按画面上看到的位置取
 */
export const smoothers = new Map<string, TargetSmoother>();
/** 各使用者声明的仍在使用的目标键：状态只在没有任何使用者声明时释放 */
const claims = new Map<object, ReadonlySet<string>>();

const NONE: ReadonlySet<string> = new Set();

function claimed(key: string): boolean {
  for (const keys of claims.values()) if (keys.has(key)) return true;
  return false;
}

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

/**
 * 使用者 owner 声明自己仍在使用的目标键（整体替换上一次的声明），并释放不再被任何使用者声明的状态。
 * 各使用者只管自己的目标：一方不再使用的状态若另一方仍在用就保留，否则对方的滤波每帧被清空重建
 */
export function retain(owner: object, alive: ReadonlySet<string>): void {
  claims.set(owner, alive);
  forget(alive);
}

/** 使用者卸载：撤销其声明并释放只有它在用的状态 */
export function release(owner: object): void {
  if (claims.delete(owner)) forget(NONE);
}

/** 释放不在 alive 中、也没有任何使用者声明的状态 */
export function forget(alive: ReadonlySet<string>): void {
  for (const key of smoothers.keys()) if (!alive.has(key) && !claimed(key)) smoothers.delete(key);
}
