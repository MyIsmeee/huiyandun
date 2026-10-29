import { describe, expect, it } from "vitest";
import { type Figure, facing, figure, HEAD_R, type Vec3 } from "../../src/scene/pose";
import type { Target } from "../../src/store/live";

/** 1.7 m 人员站立时各关键点相对脚点的横向偏移与高度（米），COCO 17 点顺序；画面右侧为正 */
const STANDING: [number, number][] = [
  [0, 1.58], // 鼻
  [-0.03, 1.62],
  [0.03, 1.62],
  [-0.07, 1.6],
  [0.07, 1.6],
  [-0.19, 1.4], // 肩
  [0.19, 1.4],
  [-0.22, 1.08], // 肘
  [0.22, 1.08],
  [-0.22, 0.82], // 腕
  [0.22, 0.82],
  [-0.1, 0.9], // 髋
  [0.1, 0.9],
  [-0.1, 0.5], // 膝
  [0.1, 0.5],
  [-0.1, 0.08], // 踝
  [0.1, 0.08],
];
const ASPECT = 16 / 9;
/** 画面中每米对应的归一化高度：站立时人高占画面一半 */
const K = 0.5 / 1.7;

/**
 * 把人体坐标（米）画到画面上，脚点在 u = 0.45；rotate 为画面内旋转角（跌倒为 90°）；hidden 中的关键点置信度为 0；
 * 检测框底边为最低的可见关键点
 */
function frame(points: [number, number][], rotate = 0, hidden: number[] = []): { keypoints: Target["keypoints"]; bbox: Target["bbox"] } {
  const [c, s] = [Math.cos(rotate), Math.sin(rotate)];
  const keypoints = points.map(([side, height], i) => {
    const [x, y] = [side * c + height * s, -side * s + height * c];
    return [0.45 + (x * K) / ASPECT, 0.8 - y * K, hidden.includes(i) ? 0 : 0.9];
  });
  const seen = keypoints.filter(([, , score]) => score);
  const us = (seen.length ? seen : keypoints).map(([u]) => u ?? 0);
  const vs = (seen.length ? seen : keypoints).map(([, v]) => v ?? 0);
  return { keypoints, bbox: [Math.min(...us), Math.min(...vs) - 0.1 * K, Math.max(...us), Math.max(...vs)] };
}

const length = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
/** 第一段为躯干（肩中到髋中） */
const torso = (f: Figure | null) => (f?.bones[0] ? length(f.bones[0].from, f.bones[0].to) : Number.NaN);
const heights = (f: Figure | null) => f?.bones.flatMap((b) => [b.from[1], b.to[1]]) ?? [];
/** 骨段次序：躯干、颈部、双肩、双髋、左上臂、左前臂、右上臂、右前臂、左大腿、左小腿、右大腿、右小腿（左右为 COCO 序号 5/6 等） */
const [SHOULDER_LINE, WRIST_5, UPPER_ARM_6, FOREARM_6] = [2, 5, 6, 7];
const LEGS = [8, 9, 10, 11];
const inferred = (f: Figure | null) => f?.bones.flatMap((b, i) => (b.inferred ? [i] : [])) ?? [];
const RIGHT: [number, number] = [1, 0];

describe("figure", () => {
  it("站立：脚踝落地，头部约 1.55 m、躯干约 0.5 m", () => {
    const { keypoints, bbox } = frame(STANDING);
    const f = figure(keypoints, bbox, RIGHT);

    expect(f?.head.at[1]).toBeCloseTo(1.55, 1);
    expect(torso(f)).toBeCloseTo(0.5, 1);
    expect(Math.min(...heights(f))).toBe(0);
    expect(inferred(f)).toEqual([]);
    expect(f?.head.inferred).toBe(false);
  });

  it("跌倒：人形躺倒，尺度不因检测框变矮而放大", () => {
    const up = frame(STANDING);
    const down = frame(STANDING, Math.PI / 2);
    const standing = figure(up.keypoints, up.bbox, RIGHT);
    const fallen = figure(down.keypoints, down.bbox, RIGHT);

    expect(Math.max(...heights(fallen))).toBeLessThan(0.5);
    expect(torso(fallen)).toBeCloseTo(torso(standing), 3);
  });

  it("抬手：手腕高过头顶，尺度与站立一致", () => {
    const raised = STANDING.map(([side, height], i): [number, number] =>
      i === 7 || i === 8 ? [side, 1.7] : i === 9 || i === 10 ? [side, 1.98] : [side, height],
    );
    const { keypoints, bbox } = frame(raised);
    const f = figure(keypoints, bbox, RIGHT);
    const top = Math.max(...heights(f));

    expect(top).toBeGreaterThan((f?.head.at[1] ?? Number.POSITIVE_INFINITY) + 0.2);
    expect(f?.head.at[1]).toBeCloseTo(1.55, 1);
  });

  it("看不见的手腕：按标准前臂长度沿竖直向下补全，只有该段半透明", () => {
    const { keypoints, bbox } = frame(STANDING, 0, [9]);
    const f = figure(keypoints, bbox, RIGHT);
    const forearm = f?.bones[WRIST_5];

    expect(f?.bones).toHaveLength(12);
    expect(inferred(f)).toEqual([WRIST_5]);
    expect(forearm && length(forearm.from, forearm.to)).toBeCloseTo(0.26, 5);
    expect(forearm?.to[0]).toBeCloseTo(forearm?.from[0] ?? Number.NaN, 5);
    expect(forearm?.to[1]).toBeLessThan(forearm?.from[1] ?? 0);
  });

  it("单侧肩缺失：按髋连线等比例（肩宽 0.38 : 髋宽 0.20）补在另一侧，与可见的髋同向", () => {
    const { keypoints, bbox } = frame(STANDING, 0, [6]);
    const f = figure(keypoints, bbox, RIGHT);
    const [line, hips] = [f?.bones[SHOULDER_LINE], f?.bones[3]];

    expect(inferred(f)).toEqual([SHOULDER_LINE, UPPER_ARM_6]);
    expect((line?.to[0] ?? 0) - (line?.from[0] ?? 0)).toBeCloseTo((((hips?.to[0] ?? 0) - (hips?.from[0] ?? 0)) * 0.19) / 0.1, 5);
    expect((line?.to[0] ?? 0) - (line?.from[0] ?? 0)).toBeCloseTo(0.38, 2);
    expect(line?.to[1]).toBeCloseTo(line?.from[1] ?? Number.NaN, 5);
    expect(f?.bones[FOREARM_6]?.inferred).toBe(false);
  });

  it("侧身时缺远侧的髋：按肩连线等比例补出，随透视缩短，不因两肩重叠而乱跳", () => {
    // 侧身对着摄像头：横向偏移按 cos 80° 缩短，远侧左髋被身体挡住
    const side = STANDING.map(([x, height]): [number, number] => [x * Math.cos((80 * Math.PI) / 180), height]);
    const { keypoints, bbox } = frame(side, 0, [11]);
    const f = figure(keypoints, bbox, RIGHT);
    const hips = f?.bones[3]; // 双髋连线，from 为补出的左髋
    const shoulders = f?.bones[SHOULDER_LINE];
    const across = (b?: { from: Vec3; to: Vec3 }) => (b?.to[0] ?? 0) - (b?.from[0] ?? 0);

    expect(hips?.inferred).toBe(true);
    expect(across(hips)).toBeCloseTo((across(shoulders) * 0.1) / 0.19, 5);
    expect(hips?.from[1]).toBeCloseTo(hips?.to[1] ?? Number.NaN, 5);
  });

  it("同侧肩与髋都缺、另一对也不完整：垂直于躯干补出，按面向摄像头（COCO 左侧在画面右方）", () => {
    const { keypoints, bbox } = frame(STANDING, 0, [6, 12]);
    const f = figure(keypoints, bbox, RIGHT);
    const [shoulders, hips] = [f?.bones[SHOULDER_LINE], f?.bones[3]];

    expect(inferred(f)).toEqual([SHOULDER_LINE, 3, UPPER_ARM_6, 10]); // 双肩、双髋、右上臂、右大腿
    expect((shoulders?.to[0] ?? 0) - (shoulders?.from[0] ?? 0)).toBeLessThan(0); // 右肩补在左肩的画面左方
    expect(shoulders && length(shoulders.from, shoulders.to)).toBeCloseTo(0.38, 1);
    expect(hips && length(hips.from, hips.to)).toBeCloseTo(0.2, 1);
  });

  it("肘看不清、腕看得见：肘按上臂长度自肩竖直向下补出，腕照实", () => {
    const all = frame(STANDING);
    const { keypoints, bbox } = frame(STANDING, 0, [7]);
    const full = figure(all.keypoints, all.bbox, RIGHT);
    const f = figure(keypoints, bbox, RIGHT);
    const [upper, lower] = [f?.bones[4], f?.bones[WRIST_5]];

    expect(inferred(f)).toEqual([4, WRIST_5]);
    expect(upper?.to[0]).toBeCloseTo(upper?.from[0] ?? Number.NaN, 5);
    expect((upper?.from[1] ?? 0) - (upper?.to[1] ?? 0)).toBeCloseTo(0.3, 5);
    expect(lower?.to[0]).toBeCloseTo(full?.bones[WRIST_5]?.to[0] ?? Number.NaN, 5);
    expect(lower?.to[1]).toBeCloseTo(full?.bones[WRIST_5]?.to[1] ?? Number.NaN, 5);
  });

  it("头部缺失：补在肩中沿躯干方向上方 0.20 m", () => {
    const { keypoints, bbox } = frame(STANDING, 0, [0, 1, 2, 3, 4]);
    const f = figure(keypoints, bbox, RIGHT);

    expect(f?.head.inferred).toBe(true);
    expect(f?.head.at[0]).toBeCloseTo(0, 5);
    expect(f?.head.at[1]).toBeCloseTo((f?.bones[0]?.from[1] ?? 0) + 0.2, 5); // 躯干自肩中起
    expect(inferred(f)).toEqual([1]); // 颈部
  });

  it("下半身被挡：腿按标准骨长补全，整体抬高到补出的脚踝落地", () => {
    const { keypoints, bbox } = frame(STANDING, 0, [13, 14, 15, 16]);
    const f = figure(keypoints, bbox, RIGHT);
    const hip = f?.bones[LEGS[0] ?? 0]?.from;

    expect(inferred(f)).toEqual(LEGS);
    expect(Math.min(...heights(f))).toBeCloseTo(0, 5);
    expect(hip?.[1]).toBeCloseTo(0.84, 5);
    expect(torso(f)).toBeCloseTo(0.5, 1);
  });

  for (const [name, hidden] of [
    ["一条手臂看不清", [7, 9]],
    ["一只脚踝看不清", [15]],
  ] as const) {
    it(`跌倒时${name}：不抬高，躯干高度与全部可见时一致`, () => {
      const all = frame(STANDING, Math.PI / 2);
      const part = frame(STANDING, Math.PI / 2, [...hidden]);
      const full = figure(all.keypoints, all.bbox, RIGHT);
      const f = figure(part.keypoints, part.bbox, RIGHT);

      // 缺的骨段不参与尺度估计，尺度有毫米级差异；抬高则会差 0.1 m 以上
      expect(f?.bones[0]?.from[1]).toBeCloseTo(full?.bones[0]?.from[1] ?? Number.NaN, 2);
      expect(f?.bones[0]?.to[1]).toBeCloseTo(full?.bones[0]?.to[1] ?? Number.NaN, 2);
    });
  }

  for (const [name, hidden] of [
    ["关键点全部看不清", STANDING.map((_, i) => i)],
    ["只看得见头部", STANDING.map((_, i) => i).filter((i) => i > 4)],
    ["看不见双髋", [11, 12]],
  ] as const) {
    it(`躯干无法确定（${name}）：整体为半透明的 1.7 m 标准站立人形，立在脚点上`, () => {
      const { keypoints, bbox } = frame(STANDING, 0, [...hidden]);
      const f = figure(keypoints, bbox, RIGHT);
      const sides = f?.bones.flatMap((b) => [b.from[0], b.to[0]]) ?? [];

      expect(f?.bones).toHaveLength(12);
      expect(inferred(f)).toHaveLength(12);
      expect(f?.head.inferred).toBe(true);
      expect((f?.head.at[1] ?? 0) + HEAD_R).toBeCloseTo(1.7, 1);
      expect(Math.min(...heights(f))).toBeGreaterThanOrEqual(0);
      expect(Math.min(...heights(f))).toBeLessThan(0.1);
      expect(Math.max(...sides) + Math.min(...sides)).toBeCloseTo(0, 5);
    });
  }

  it("车辆没有关键点：不生成人形", () => {
    expect(figure(null, [0, 0, 1, 1], RIGHT)).toBeNull();
  });

  it("画面左侧的关键点落在 right 的反方向上", () => {
    const { keypoints, bbox } = frame(STANDING);
    const f = figure(keypoints, bbox, [0, -1]);
    const leftShoulder = f?.bones[2]?.from; // 躯干、颈部之后为双肩连线，from 为画面左侧的肩

    expect(leftShoulder?.[0]).toBeCloseTo(0, 5);
    expect(leftShoulder?.[2]).toBeGreaterThan(0);
  });
});

describe("facing", () => {
  it("人形平面垂直于摄像头到人员的连线：画面右方即摄像头视线的右侧", () => {
    // 摄像头看向 +x 时，右侧为平面 +y（俯视平面 y 轴向下）
    expect(facing({ x: 0, y: 0, height_m: 3, yaw_deg: 0, pitch_deg: -30, hfov_deg: 90, range_m: 10 }, 5, 0)).toEqual([-0, 1]);
  });
});
