import { describe, expect, it } from "vitest";
import { facing, figure } from "../../src/scene/pose";
import { renderDelay, TargetSmoother } from "../../src/scene/smoothing";
import { positionAt } from "../../src/scene/targets";
import type { Target } from "../../src/store/live";

/** 可复现的正态噪声（Box-Muller + 线性同余） */
function noise(seed = 1) {
  let s = seed;
  const uniform = () => {
    s = (s * 1664525 + 1013904223) % 2 ** 32;
    return (s + 0.5) / 2 ** 32;
  };
  return (sigma: number) => sigma * Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform());
}

const std = (values: number[]) => {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length);
};

const FRAME_MS = 1000 / 60;
const SAMPLE_MS = 125; // 检测约 8 FPS
const STILL = { heading_deg: null, keypoints: null, bbox: [0, 0, 0, 0] };

/**
 * 按实测轨迹逐帧渲染 durationMs：每 SAMPLE_MS 到达一次带噪声的实测，渲染时刻为当前减去自适应延迟。
 * 返回每帧 [当前时刻, 平滑后的位置 x, 原始插值位置 x, 渲染时刻的真实 x]
 */
function render(truth: (t: number) => number, sigma: number, durationMs: number, seed = 1) {
  const n = noise(seed);
  const smoother = new TargetSmoother();
  const trail: [number, number, number][] = [];
  const out: [number, number, number, number][] = [];
  for (let now = 0; now <= durationMs; now += FRAME_MS) {
    while ((trail.at(-1)?.[2] ?? -SAMPLE_MS) + SAMPLE_MS <= now) {
      const at = (trail.at(-1)?.[2] ?? -SAMPLE_MS) + SAMPLE_MS;
      trail.push([truth(at) + n(sigma), 0, at]);
    }
    smoother.update({ ...STILL, trail });
    const t = now - renderDelay(trail);
    out.push([now, smoother.position(t)[0], positionAt(trail, t)[0], truth(t)]);
  }
  return out;
}

describe("renderDelay（V-A7）", () => {
  const trail = (gap: number, n = 11) => Array.from({ length: n }, (_, i) => [0, 0, i * gap] as const);

  it("取最近到达间隔中位数的 1.5 倍，限定在 150～400 ms；没有间隔时取默认", () => {
    expect(renderDelay(trail(125))).toBeCloseTo(187.5);
    expect(renderDelay(trail(50))).toBe(150);
    expect(renderDelay(trail(400))).toBe(400);
    expect(renderDelay(trail(125, 1))).toBe(250);
  });
});

describe("位置平滑（V-A7、V-P4）", () => {
  it("静止目标：渲染位置的抖动（标准差）不超过未滤波插值的一半", () => {
    for (const seed of [1, 2, 3]) {
      const frames = render(() => 5, 0.05, 8000, seed).filter(([now]) => now >= 3000);
      expect(std(frames.map(([, x]) => x))).toBeLessThanOrEqual(0.5 * std(frames.map(([, , raw]) => raw)));
    }
  });

  it("1.4 m/s 匀速行走：滤波带来的滞后（不含渲染延迟）≤ 0.15 m；渲染位置不超过最新实测（不外推）", () => {
    const frames = render((t) => 1.4 * (t / 1000), 0, 6000).filter(([now]) => now >= 2000);
    for (const [now, x, , truth] of frames) {
      expect(truth - x).toBeLessThanOrEqual(0.15);
      expect(x).toBeLessThanOrEqual(1.4 * (now / 1000) + 1e-9);
    }
  });

  it("只处理新到达的实测；轨迹时间窗移出的点随之丢弃", () => {
    const smoother = new TargetSmoother();
    smoother.update({ ...STILL, trail: [[0, 0, 0], [1, 0, 100]] });
    smoother.update({ ...STILL, trail: [[1, 0, 100], [2, 0, 200]] });
    expect(smoother.trail.map(([, , at]) => at)).toEqual([100, 200]);
  });

  it("朝向在 ±180° 处连续：-179° 与 179° 之间不绕一圈", () => {
    const smoother = new TargetSmoother();
    const trail: [number, number, number][] = [];
    for (let i = 0; i < 20; i += 1) {
      trail.push([0, 0, i * SAMPLE_MS]);
      smoother.update({ ...STILL, trail, heading_deg: i % 2 === 0 ? 179 : -179 });
    }
    expect(Math.abs(Math.cos(smoother.angle ?? 0) + 1)).toBeLessThan(0.01);
  });
});

/** 正面站立、画面高约 0.5 的人员关键点（COCO 17 点） */
const STANDING: [number, number][] = [
  [0.5, 0.3], [0.49, 0.29], [0.51, 0.29], [0.48, 0.3], [0.52, 0.3],
  [0.46, 0.36], [0.54, 0.36], [0.45, 0.45], [0.55, 0.45], [0.45, 0.53], [0.55, 0.53],
  [0.47, 0.55], [0.53, 0.55], [0.47, 0.67], [0.53, 0.67], [0.47, 0.79], [0.53, 0.79],
]; // prettier-ignore
const BBOX = [0.44, 0.28, 0.56, 0.8];
const CAMERA = { x: 0, y: -10, z: 3, yaw_deg: 90, pitch_deg: -30, hfov_deg: 90, range_m: 15 } as never;

describe("骨骼平滑（V-A8、V-P4）", () => {
  /** 静止人形逐帧渲染的各关节坐标；filtered 为 false 时直接用带噪声的最新关键点（改前的做法） */
  function joints(filtered: boolean, seed: number): number[][] {
    const n = noise(seed);
    const smoother = new TargetSmoother();
    const right = facing(CAMERA, 0, 0);
    const trail: Target["trail"] = [];
    const out: number[][] = [];
    for (let at = 0; at <= 6000; at += SAMPLE_MS) {
      const keypoints = STANDING.map(([u, v]) => [u + n(0.004), v + n(0.004), 0.9]);
      const bbox = BBOX.map((b) => b + n(0.004));
      trail.push([0, 0, at]);
      smoother.update({ trail, heading_deg: null, keypoints, bbox });
      for (let t = at - SAMPLE_MS; t < at; t += FRAME_MS) {
        if (t < 3000) continue;
        const pose = filtered ? smoother.pose(t) : { keypoints, bbox };
        const f = pose && figure(pose.keypoints, pose.bbox, right);
        if (f) out.push(f.bones.flatMap((b) => [...b.from, ...b.to]));
      }
    }
    return out;
  }

  it("静止人形关键点叠加噪声：各关节抖动（标准差）不超过未滤波的一半", () => {
    for (const seed of [3, 7]) {
      const [smooth, raw] = [joints(true, seed), joints(false, seed)];
      const width = smooth[0]?.length ?? 0;
      expect(width).toBeGreaterThan(0);
      for (let j = 0; j < width; j += 1) {
        const column = (rows: number[][]) => rows.map((row) => row[j] ?? 0);
        expect(std(column(smooth))).toBeLessThanOrEqual(0.5 * std(column(raw)) + 1e-4);
      }
    }
  });

  it("可见性滞回：≥ 0.3 转可见，降到 0.2～0.3 之间仍可见，< 0.2 才转不可见", () => {
    const smoother = new TargetSmoother();
    const trail: Target["trail"] = [];
    const visible = (score: number, at: number) => {
      trail.push([0, 0, at]);
      smoother.update({ trail, heading_deg: null, keypoints: STANDING.map(([u, v]) => [u, v, score]), bbox: BBOX });
      return smoother.pose(at)?.keypoints?.[0]?.[2];
    };
    expect(visible(0.25, 0)).toBe(0);
    expect(visible(0.35, 100)).toBe(1);
    expect(visible(0.25, 200)).toBe(1);
    expect(visible(0.15, 300)).toBe(0);
  });
});
