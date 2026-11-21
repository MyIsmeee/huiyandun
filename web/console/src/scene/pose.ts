import type { Target } from "../store/live";
import type { Camera } from "./devices";

/** 画面宽高比：演示与常见监控码流均为 16:9；关键点的横向偏移按此换算为与纵向相同的单位 */
const ASPECT = 16 / 9;
/** 关键点置信度低于此值视为不可见，按标准骨长补全并半透明（D-056；与 vision-engine 的 KEYPOINT_MIN 一致） */
export const KEYPOINT_MIN = 0.3;
/** 躯干、颈部与头部半径（米） */
const TORSO_R = 0.13;
const NECK_R = 0.045;
export const HEAD_R = 0.11;

const SHOULDERS = [5, 6];
const HIPS = [11, 12];
const HEAD = [0, 1, 2, 3, 4]; // 鼻、双眼、双耳
const ANKLES = [15, 16];
/** 骨段的部位：按部位取人形零件（parts.ts）；肩、髋连线没有零件，画成胶囊 */
export type Part = "torso" | "neck" | "upperArm" | "forearm" | "thigh" | "shin" | "foot";
/** 四肢与肩、髋连线：两端关键点（COCO 17 点序号）、半径（米）与部位 */
export const LIMBS: (readonly [number, number, number, Part?])[] = [
  [5, 6, 0.06],
  [11, 12, 0.07],
  [5, 7, 0.05, "upperArm"],
  [7, 9, 0.045, "forearm"],
  [6, 8, 0.05, "upperArm"],
  [8, 10, 0.045, "forearm"],
  [11, 13, 0.065, "thigh"],
  [13, 15, 0.055, "shin"],
  [12, 14, 0.065, "thigh"],
  [14, 16, 0.055, "shin"],
];
/** 脚长（米）：脚踝到脚尖；脚的半径只用于包围盒 */
const FOOT_M = 0.19;
const FOOT_R = 0.045;
/** 尺度参照：1.7 m 人员的躯干（肩中到髋中）、大腿、小腿长度（米）；抬手、弯腰、跌倒时长度不变，检测框高度会变 */
const BONES: (readonly [number[], number[], number])[] = [
  [SHOULDERS, HIPS, 0.5],
  [[11], [13], 0.42],
  [[12], [14], 0.42],
  [[13], [15], 0.42],
  [[14], [16], 0.42],
];
/** 补全用的标准尺寸（米，设计 §3.4）：肩、髋半宽，四肢链（自躯干向外）与各段骨长，头部在肩中上方的距离 */
const HALF_WIDTH: Record<number, number> = { 5: 0.19, 6: 0.19, 11: 0.1, 12: 0.1 };
const CHAINS: (readonly [number, number, number, number, number])[] = [
  [5, 7, 9, 0.3, 0.26],
  [6, 8, 10, 0.3, 0.26],
  [11, 13, 15, 0.42, 0.42],
  [12, 14, 16, 0.42, 0.42],
];
const HEAD_ABOVE_M = 0.2;
/** 躯干无法确定时的 1.7 m 标准站立人形：双肩、双髋（横向偏移、高度），其余部位由补全生成 */
const STANDARD: Record<number, P> = { 5: [0.19, 1.4], 6: [-0.19, 1.4], 11: [0.1, 0.9], 12: [-0.1, 0.9] };

export type Vec3 = [number, number, number];
export interface Bone {
  from: Vec3;
  to: Vec3;
  radius: number;
  /** 由标准骨长推测、不是实测（D-056）：半透明呈现 */
  inferred: boolean;
  /** 部位：有零件的骨段按零件呈现，否则为半径 radius 的胶囊 */
  part?: Part;
  /** 零件绕骨段的转角参照（见 parts.ts placePart）：躯干为右肩 → 左肩，脚为使零件 +z 朝脚背的方向 */
  side?: Vec3;
}
/** 姿态人形：以脚点为原点的场景坐标（x、高度、平面 y），平面坐标与场景一致 */
export interface Figure {
  /** body() 按坐姿重建（供下一帧的回差判定） */
  seated?: boolean;
  /** 坐姿时采用的身体朝向（平面方向角，弧度，(cos, sin)）：供下一帧沿用，坐着的人不逐帧前后翻转 */
  front?: number;
  bones: Bone[];
  head: { at: Vec3; inferred: boolean };
}

/** 人形平面内的点：画面右侧为正的横向偏移、离地高度（米） */
type P = [number, number];
const add = (p: P, q: P, k = 1): P => [p[0] + q[0] * k, p[1] + q[1] * k];
/** 单位向量；零长（如肩中与髋中在画面上重合）时取竖直向上，不产生 NaN 使人形整个不画 */
const unit = ([s, h]: P): P => {
  const n = Math.hypot(s, h);
  return n > 1e-9 ? [s / n, h / n] : [0, 1];
};

/**
 * 双脚：关键点没有脚尖，自各小腿末端（脚踝）伸出 FOOT_M，方向取身体朝向 front 垂直于小腿的分量（站立时水平向前，
 * 抬腿时随小腿转动；小腿与朝向平行时取朝上，即仰面躺着脚尖朝上），脚尖不低于地面。是否推测随所在小腿
 */
export function feet(bones: Bone[], front: Vec3): Bone[] {
  return bones.flatMap((shin): Bone[] => {
    if (shin.part !== "shin") return [];
    const ankle = shin.to;
    const d: Vec3 = [shin.to[0] - shin.from[0], shin.to[1] - shin.from[1], shin.to[2] - shin.from[2]];
    const n = Math.hypot(...d);
    const s: Vec3 = n > 1e-9 ? [d[0] / n, d[1] / n, d[2] / n] : [0, -1, 0];
    const across = (v: Vec3): Vec3 => {
      const k = v[0] * s[0] + v[1] * s[1] + v[2] * s[2];
      return [v[0] - s[0] * k, v[1] - s[1] * k, v[2] - s[2] * k];
    };
    let dir = across(front);
    if (Math.hypot(...dir) < 0.2) dir = across([0, 1, 0]);
    const m = Math.hypot(...dir);
    const to: Vec3 = [ankle[0] + (dir[0] / m) * FOOT_M, Math.max(0, ankle[1] + (dir[1] / m) * FOOT_M), ankle[2] + (dir[2] / m) * FOOT_M];
    // side = 脚尖方向 × 脚背方向（脚背朝膝盖一侧，即 −s）
    const f: Vec3 = [to[0] - ankle[0], to[1] - ankle[1], to[2] - ankle[2]];
    const side: Vec3 = [f[2] * s[1] - f[1] * s[2], f[0] * s[2] - f[2] * s[0], f[1] * s[0] - f[0] * s[1]];
    return [{ from: ankle, to, radius: FOOT_R, inferred: shin.inferred, part: "foot", side }];
  });
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
 * 置信度低于 0.3 的部位按标准骨长补全并标为推测（D-056）：至少一侧肩与一侧髋可见时，缺的肩、髋按标准半宽补在另一侧，
 * 四肢从最近的可见关节起竖直向下，头部在肩中沿躯干方向上方；站立时补出的脚踝低于地面则整体抬高到落地。
 * 躯干无法确定时为整体推测的标准站立人形。没有关键点（车辆）时返回 null。
 */
export function figure(keypoints: Target["keypoints"], bbox: Target["bbox"], right: [number, number]): Figure | null {
  if (!keypoints) return null;
  const [x1 = 0, , x2 = 0, y2 = 0] = bbox;
  const u0 = (x1 + x2) / 2;
  const image: (P | null)[] = keypoints.map(([u = 0, v = 0, score = 0]) =>
    score >= KEYPOINT_MIN ? [(u - u0) * ASPECT, y2 - v] : null,
  );
  const mid = (indices: number[], points = image): P | null => {
    const seen = indices.flatMap((i) => (points[i] ? [points[i]] : []));
    if (seen.length === 0) return null;
    return [seen.reduce((sum, p) => sum + p[0], 0) / seen.length, seen.reduce((sum, p) => sum + p[1], 0) / seen.length];
  };
  let real = 0;
  let length = 0;
  for (const [a, b, bone] of BONES) {
    const [p, q] = [mid(a), mid(b)];
    if (!p || !q) continue;
    real += bone;
    length += Math.hypot(p[0] - q[0], p[1] - q[1]);
  }
  // 躯干骨段（肩中到髋中）可用即可确定躯干，尺度随之可求
  const torso = mid(SHOULDERS) && mid(HIPS) && length > 0;
  const points = torso
    ? image.map((p): P | null => p && [p[0] * (real / length), p[1] * (real / length)])
    : image.map((_, i) => STANDARD[i] ?? null);
  const guessed = points.map((p) => !torso || p === null);

  // 缺一侧肩或髋：沿每米横向（COCO 左到右）补出。另一对完整时按其连线等比例换算，侧身时随透视缩短、两肩重叠也不乱跳；
  // 否则垂直于躯干、按面向摄像头（左侧在画面右方）
  const [shoulder, hip] = [mid(SHOULDERS, points), mid(HIPS, points)] as [P, P];
  const pair = [SHOULDERS, HIPS].find(([l = 0, r = 0]) => points[l] && points[r]);
  const [l0 = 0, r0 = 0] = pair ?? [];
  const across: P = pair
    ? add([0, 0], add(points[r0] as P, points[l0] as P, -1), 1 / (2 * (HALF_WIDTH[l0] ?? 0)))
    : unit([hip[1] - shoulder[1], shoulder[0] - hip[0]]);
  for (const [l = 0, r = 0] of [SHOULDERS, HIPS]) {
    const width = 2 * (HALF_WIDTH[l] ?? 0);
    if (!points[l]) points[l] = add(points[r] as P, across, -width);
    if (!points[r]) points[r] = add(points[l] as P, across, width);
  }
  for (const [a, b, c, upper, lower] of CHAINS) {
    points[b] ??= add(points[a] as P, [0, -upper]);
    points[c] ??= add(points[b] as P, [0, -lower]);
  }
  const shoulders = mid(SHOULDERS, points) as P;
  const hips = mid(HIPS, points) as P;
  const seenHead = mid(HEAD, points);
  const head = seenHead ?? add(shoulders, unit(add(shoulders, hips, -1)), HEAD_ABOVE_M);
  const headGuessed = !seenHead;

  // 站立（躯干偏离竖直不超过 45°）且补出的脚踝低于地面时整体抬高到落地，桌后只见上半身的人员按站立呈现（D-057）；
  // 跌倒等其余情况不抬高，低于地面的推测部位压在地面上
  const upright = shoulders[1] - hips[1] > Math.abs(shoulders[0] - hips[0]);
  const lift = upright ? Math.max(0, ...ANKLES.flatMap((i) => (guessed[i] ? [-(points[i] as P)[1]] : []))) : 0;
  const at = ([side, height]: P): Vec3 => [right[0] * side, Math.max(0, height + lift), right[1] * side];
  // 躯干零件的左右：右肩 → 左肩；侧身时两肩重合，取人形平面的水平方向
  const [left, rightShoulder] = [at(points[5] as P), at(points[6] as P)];
  const span: Vec3 = [left[0] - rightShoulder[0], left[1] - rightShoulder[1], left[2] - rightShoulder[2]];
  const side: Vec3 = Math.hypot(...span) > 1e-6 ? span : [right[0], 0, right[1]];
  const bones: Bone[] = [
    { from: at(shoulders), to: at(hips), radius: TORSO_R, inferred: !torso, part: "torso", side },
    { from: at(shoulders), to: at(head), radius: NECK_R, inferred: headGuessed, part: "neck" },
    ...LIMBS.map(([a, b, radius, part]) => ({
      from: at(points[a] as P),
      to: at(points[b] as P),
      radius,
      inferred: Boolean(guessed[a] || guessed[b]),
      part,
    })),
  ];
  // 画面平面人形面向摄像头：朝向取平面内垂直于 right、指向摄像头的方向（见 facing）
  bones.push(...feet(bones, [-right[1], 0, right[0]]));
  return { bones, head: { at: at(head), inferred: headGuessed } };
}
