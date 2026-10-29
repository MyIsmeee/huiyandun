import { describe, expect, it } from "vitest";
import { type Figure, facing, figure, type Vec3 } from "../../src/scene/pose";
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

/** 把人体坐标（米）画到画面上，脚点在 u = 0.45；rotate 为画面内旋转角（跌倒为 90°）；检测框底边为最低关键点 */
function frame(points: [number, number][], rotate = 0, score = 0.9): { keypoints: Target["keypoints"]; bbox: Target["bbox"] } {
  const [c, s] = [Math.cos(rotate), Math.sin(rotate)];
  const keypoints = points.map(([side, height]) => {
    const [x, y] = [side * c + height * s, -side * s + height * c];
    return [0.45 + (x * K) / ASPECT, 0.8 - y * K, score];
  });
  const us = keypoints.map(([u]) => u ?? 0);
  const vs = keypoints.map(([, v]) => v ?? 0);
  return { keypoints, bbox: [Math.min(...us), Math.min(...vs) - 0.1 * K, Math.max(...us), Math.max(...vs)] };
}

const length = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
/** 第一段为躯干（肩中到髋中） */
const torso = (f: Figure | null) => (f?.bones[0] ? length(f.bones[0].from, f.bones[0].to) : Number.NaN);
const RIGHT: [number, number] = [1, 0];

describe("figure", () => {
  it("站立：脚踝落地，头部约 1.55 m、躯干约 0.5 m", () => {
    const { keypoints, bbox } = frame(STANDING);
    const f = figure(keypoints, bbox, RIGHT);

    expect(f?.head?.[1]).toBeCloseTo(1.55, 1);
    expect(torso(f)).toBeCloseTo(0.5, 1);
    expect(Math.min(...(f?.bones.flatMap((b) => [b.from[1], b.to[1]]) ?? []))).toBe(0);
  });

  it("跌倒：人形躺倒，尺度不因检测框变矮而放大", () => {
    const up = frame(STANDING);
    const down = frame(STANDING, Math.PI / 2);
    const standing = figure(up.keypoints, up.bbox, RIGHT);
    const fallen = figure(down.keypoints, down.bbox, RIGHT);

    const heights = fallen?.bones.flatMap((b) => [b.from[1], b.to[1]]) ?? [];
    expect(Math.max(...heights)).toBeLessThan(0.5);
    expect(torso(fallen)).toBeCloseTo(torso(standing), 3);
  });

  it("抬手：手腕高过头顶，尺度与站立一致", () => {
    const raised = STANDING.map(([side, height], i): [number, number] =>
      i === 7 || i === 8 ? [side, 1.7] : i === 9 || i === 10 ? [side, 1.98] : [side, height],
    );
    const { keypoints, bbox } = frame(raised);
    const f = figure(keypoints, bbox, RIGHT);
    const top = Math.max(...(f?.bones.flatMap((b) => [b.from[1], b.to[1]]) ?? []));

    expect(top).toBeGreaterThan((f?.head?.[1] ?? Number.POSITIVE_INFINITY) + 0.2);
    expect(f?.head?.[1]).toBeCloseTo(1.55, 1);
  });

  it("置信度低于 0.3 的关键点相连的肢体不画", () => {
    const { keypoints, bbox } = frame(STANDING);
    const full = figure(keypoints, bbox, RIGHT)?.bones.length ?? 0;
    const hidden = keypoints?.map((p, i) => (i === 9 ? [p[0] ?? 0, p[1] ?? 0, 0.29] : p)) ?? null;

    expect(figure(hidden, bbox, RIGHT)?.bones).toHaveLength(full - 1);
  });

  it("没有可用骨段时按检测框高度为 1.7 m 估计尺度", () => {
    const { keypoints, bbox } = frame(STANDING);
    const headOnly = keypoints?.map((p, i) => (i <= 4 ? p : [p[0] ?? 0, p[1] ?? 0, 0])) ?? null;
    const f = figure(headOnly, bbox, RIGHT);

    const [, top = 0, , bottom = 0] = bbox;
    const head = (keypoints?.slice(0, 5).reduce((sum, [, v = 0]) => sum + v, 0) ?? 0) / 5;
    expect(f?.bones).toEqual([]);
    expect(f?.head?.[1]).toBeCloseTo(((bottom - head) * 1.7) / (bottom - top), 5);
  });

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
