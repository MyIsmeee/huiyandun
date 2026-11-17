import { Euler, Matrix4, Quaternion, Vector3 } from "three";
import type { SceneFrame } from "../editor/recognition";
import type { Asset, SceneItem } from "./assets";

/**
 * 落座绑定：坐着的人形髋部固定在椅子上，不随逐帧位置抖动。
 *
 * 坐在桌后的人脚踝时隐时现，视觉引擎的脚点在"脚踝、按站立比例由髋推算、检测框底边"之间逐帧切换（footing.py），
 * 坐着的人又按站立比例推算，地面位置随之来回跳动，远处可达半米以上。人形按坐姿重建（body.ts）后，在髋部 SEAT_RADIUS_M 内
 * 有椅子时把髋部吸附到椅面中心；附近没有椅子时就地锁定。实测偏离锁定点超过 HOLD_M 持续 HOLD_MS 才认为换了位置，
 * 不再是坐姿持续 RELEASE_MS 才解除：坐、站判定偶尔翻一帧时人形不跳。
 */

/** 平面坐标（米），与场景的 (x, 0, y) 对应 */
export type Seat = readonly [number, number];

/** 髋部离椅面中心不超过此距离即吸附：坐着时脚点推算偏差大，常在 0.5 m 以上 */
export const SEAT_RADIUS_M = 1.0;
/** 锁定后实测髋部偏离锁定点超过此距离、持续 HOLD_MS，才认为换了位置（挪到别的座位、坐着滑开） */
export const HOLD_M = 0.8;
export const HOLD_MS = 1500;
/** 不再是坐姿持续此时长才解除锁定 */
export const RELEASE_MS = 1000;

/** 手工场景中可坐的资产：椅子取占地中心；沙发长 2 m，按两个座位取长边两侧的中点 */
const CHAIRS = new Set(["office-chair", "chair", "armchair"]);
const SOFAS = new Set(["sofa"]);
/** 自动场景中可坐的物体：椅类、沙发与长凳（scene_frame 的 class 与 kind） */
const SEAT_CLASSES = new Set(["chair", "sofa"]);
const SEAT_KINDS = new Set(["bench", "seat", "stool", "armchair", "swivel_chair"]);

export function seatsFromItems(items: SceneItem[]): Seat[] {
  return items.flatMap(({ asset, x, y, rot }): Seat[] => {
    if (CHAIRS.has(asset)) return [[x, y]];
    if (!SOFAS.has(asset)) return [];
    const a = (rot * Math.PI) / 180;
    const [dx, dy] = [Math.cos(a) * 0.5, Math.sin(a) * 0.5];
    return [
      [x - dx, y - dy],
      [x + dx, y + dy],
    ];
  });
}

export function seatsFromFrames(frames: SceneFrame[]): Seat[] {
  return frames.flatMap((frame) =>
    frame.objects
      .filter((o) => SEAT_CLASSES.has(o.class) || (o.kind !== undefined && SEAT_KINDS.has(o.kind)))
      .flatMap((o): Seat[] => {
        if (o.polygon.length === 0) return [];
        const sum = o.polygon.reduce<[number, number]>(([sx, sy], [px = 0, py = 0]) => [sx + px, sy + py], [0, 0]);
        return [[sum[0] / o.polygon.length, sum[1] / o.polygon.length]];
      }),
  );
}

/** 一个人形的锁定状态：at 为锁定的髋部平面位置；seat 为是否吸附在椅子上；away、stood 为开始偏离、开始不坐的时刻 */
export interface Anchor {
  at: Seat;
  seat: boolean;
  away: number | null;
  stood: number | null;
}

const distance = (a: Seat, b: Seat) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** 最近的空座位（taken 为别人已占的）；SEAT_RADIUS_M 内没有时就地锁定 */
function acquire(hip: Seat, seats: readonly Seat[], taken: readonly Seat[]): Anchor {
  let best: Seat | null = null;
  for (const seat of seats) {
    if (distance(seat, hip) > SEAT_RADIUS_M) continue;
    if (taken.some((t) => distance(t, seat) < 1e-6)) continue;
    if (!best || distance(seat, hip) < distance(best, hip)) best = seat;
  }
  return { at: best ?? hip, seat: best !== null, away: null, stood: null };
}

/**
 * 本帧的锁定状态：seated 为本帧按坐姿重建，hip 为实测髋部的平面位置，now 为毫秒时刻。
 * 返回 undefined 表示不锁定（站着、走动），人形照实测位置画
 */
/** 补椅子用的资产：办公椅（模型正面朝 +z，靠背在 −z） */
export const CHAIR_ASSET = "office-chair";

/**
 * 坐着却没有可吸附的椅子（场景里没识别出椅子，多是被坐着的人挡住）时，在锁定的髋部位置补一把椅子，
 * 人形不悬空坐着。front 为身体朝向（平面方向角，弧度，(cos, sin)），椅子正面转到同一方向
 */
export function chairMatrix(at: Seat, front: number, asset: Asset): Matrix4 {
  // 绕竖直轴转 a 后模型 +z 指向平面 (sin a, cos a)：要与 (cos front, sin front) 一致
  const angle = Math.PI / 2 - front - (asset.yaw * Math.PI) / 180;
  return new Matrix4().compose(
    new Vector3(at[0], 0, at[1]),
    new Quaternion().setFromEuler(new Euler(0, angle, 0)),
    new Vector3().setScalar(asset.scale),
  );
}

export function settle(
  prev: Anchor | undefined,
  seated: boolean,
  hip: Seat,
  seats: readonly Seat[],
  now: number,
  taken: readonly Seat[] = [],
): Anchor | undefined {
  if (!seated) {
    if (!prev) return undefined;
    const stood = prev.stood ?? now;
    return now - stood >= RELEASE_MS ? undefined : { ...prev, stood };
  }
  if (!prev) return acquire(hip, seats, taken);
  if (distance(hip, prev.at) <= HOLD_M) return { ...prev, away: null, stood: null };
  const away = prev.away ?? now;
  return now - away >= HOLD_MS ? acquire(hip, seats, taken) : { ...prev, away, stood: null };
}
