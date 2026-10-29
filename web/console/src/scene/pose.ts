import type { Target } from "../store/live";
import type { Camera } from "./devices";

/** 画面宽高比：演示与常见监控码流均为 16:9；关键点的横向偏移按此换算为与纵向相同的单位 */
const ASPECT = 16 / 9;
/** 关键点置信度低于此值视为不可见，相关肢体不画（与 vision-engine 的 KEYPOINT_MIN 一致） */
export const KEYPOINT_MIN = 0.3;
/** 人员身高：没有可用骨段估计尺度时，检测框高度按此换算 */
const HEIGHT_M = 1.7;
/** 躯干、颈部与头部半径（米） */
const TORSO_R = 0.13;
const NECK_R = 0.045;
export const HEAD_R = 0.11;

const SHOULDERS = [5, 6];
const HIPS = [11, 12];
const HEAD = [0, 1, 2, 3, 4]; // 鼻、双眼、双耳
/** 四肢与肩、髋连线：两端关键点（COCO 17 点序号）与胶囊半径（米） */
const LIMBS: (readonly [number, number, number])[] = [
  [5, 6, 0.06],
  [11, 12, 0.07],
  [5, 7, 0.05],
  [7, 9, 0.045],
  [6, 8, 0.05],
  [8, 10, 0.045],
  [11, 13, 0.065],
  [13, 15, 0.055],
  [12, 14, 0.065],
  [14, 16, 0.055],
];
/** 尺度参照：1.7 m 人员的躯干（肩中到髋中）、大腿、小腿长度（米）；抬手、弯腰、跌倒时长度不变，检测框高度会变 */
const BONES: (readonly [number[], number[], number])[] = [
  [SHOULDERS, HIPS, 0.5],
  [[11], [13], 0.42],
  [[12], [14], 0.42],
  [[13], [15], 0.42],
  [[14], [16], 0.42],
];

export type Vec3 = [number, number, number];
export interface Bone {
  from: Vec3;
  to: Vec3;
  radius: number;
}
/** 姿态人形：以脚点为原点的场景坐标（x、高度、平面 y），平面坐标与场景一致 */
export interface Figure {
  bones: Bone[];
  head: Vec3 | null;
}

/** 人形所在竖直平面的水平方向：垂直于摄像头到人员的连线，即画面中的向右方向（平面坐标 [x, y]） */
export function facing(pose: Camera["pose"], x: number, y: number): [number, number] {
  const [dx, dy] = [x - pose.x, y - pose.y];
  const length = Math.hypot(dx, dy);
  return length === 0 ? [1, 0] : [-dy / length, dx / length];
}

/**
 * 由骨骼关键点生成姿态人形（§5.1 L4）：关键点按画面位置放到朝向摄像头的竖直平面上，脚点（检测框底边中点）落在地面，
 * 从摄像头看去与画面姿态一致。尺度取躯干与腿部骨段的画面长度，跌倒时人形不会因检测框变矮而放大。
 * 两端置信度均不低于 0.3 的肢体才画；没有关键点（车辆）时返回 null。
 */
export function figure(keypoints: Target["keypoints"], bbox: Target["bbox"], right: [number, number]): Figure | null {
  if (!keypoints) return null;
  const mid = (indices: number[]): [number, number] | null => {
    const seen = indices.flatMap((i) => {
      const point = keypoints[i];
      return point && (point[2] ?? 0) >= KEYPOINT_MIN ? [point] : [];
    });
    if (seen.length === 0) return null;
    const mean = (k: number) => seen.reduce((sum, p) => sum + (p[k] ?? 0), 0) / seen.length;
    return [mean(0), mean(1)];
  };
  let real = 0;
  let image = 0;
  for (const [a, b, length] of BONES) {
    const [p, q] = [mid(a), mid(b)];
    if (!p || !q) continue;
    real += length;
    image += Math.hypot((p[0] - q[0]) * ASPECT, p[1] - q[1]);
  }
  const [x1 = 0, y1 = 0, x2 = 0, y2 = 0] = bbox;
  const scale = image > 0 ? real / image : HEIGHT_M / Math.max(y2 - y1, 1e-3);
  const u0 = (x1 + x2) / 2;
  const at = ([u, v]: [number, number]): Vec3 => {
    const side = (u - u0) * ASPECT * scale;
    return [right[0] * side, Math.max(0, (y2 - v) * scale), right[1] * side];
  };
  const bones: Bone[] = [];
  const add = (p: [number, number] | null, q: [number, number] | null, radius: number) => {
    if (p && q) bones.push({ from: at(p), to: at(q), radius });
  };
  const [shoulders, hips, head] = [mid(SHOULDERS), mid(HIPS), mid(HEAD)];
  add(shoulders, hips, TORSO_R);
  add(shoulders, head, NECK_R);
  for (const [a, b, radius] of LIMBS) add(mid([a]), mid([b]), radius);
  return { bones, head: head && at(head) };
}
