import type { components } from "../../api/schema";

type CameraInfo = components["schemas"]["CameraInfo"];
type Point = readonly [number, number];

/**
 * 警戒线与规则区域画到实时画面上：攀爬警戒线本就是画面像素坐标；区域入侵与越线规则是平面坐标（米），
 * 按与 vision-engine 同一地面映射投到画面上（geometry.py）：有 ≥ 4 组标定点时按标定点拟合单应矩阵，
 * 否则按安装参数以针孔模型估算（D-102）。结果为画面归一化坐标，摄像头背后与地平线以上的部分裁掉
 */

/** 平面点 → [u, v, 深度]：u、v 为画面归一化坐标；深度 ≤ 0 为摄像头背后或地平线以上，不可画 */
export type Project = (x: number, y: number) => readonly [number, number, number];

const MIN_POINTS = 4;
/** 深度下限：针孔模型为相机前方米数，单应为齐次坐标 w；贴近地平线的点投到极远处，裁掉 */
const NEAR = 0.05;

/** 小规模线性方程组（高斯消元、列主元）；奇异时返回 null */
function solve(a: number[][], b: number[]): number[] | null {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i] ?? 0]);
  for (let c = 0; c < n; c++) {
    let pivot = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r]?.[c] ?? 0) > Math.abs(m[pivot]?.[c] ?? 0)) pivot = r;
    const p = m[pivot];
    if (!p || Math.abs(p[c] ?? 0) < 1e-12) return null;
    [m[c], m[pivot]] = [p, m[c] ?? p];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const row = m[r];
      if (!row) continue;
      const f = (row[c] ?? 0) / (p[c] ?? 1);
      for (let k = c; k <= n; k++) row[k] = (row[k] ?? 0) - f * (p[k] ?? 0);
    }
  }
  return m.map((row, i) => (row[n] ?? 0) / (row[i] ?? 1));
}

/** 由标定点 [u, v, x, y]（像素与平面米）按最小二乘拟合平面 → 画面的单应；size 为画面像素宽高 */
export function homography(calibration: readonly (readonly number[])[], size: Point): Project | null {
  if (calibration.length < MIN_POINTS) return null;
  const [w, h] = size;
  // 平面坐标以重心为原点，方程组的条件数小些
  const cx = calibration.reduce((s, p) => s + (p[2] ?? 0), 0) / calibration.length;
  const cy = calibration.reduce((s, p) => s + (p[3] ?? 0), 0) / calibration.length;
  const ata = Array.from({ length: 8 }, () => new Array<number>(8).fill(0));
  const atb = new Array<number>(8).fill(0);
  for (const [pu = 0, pv = 0, px = 0, py = 0] of calibration) {
    const [u, v, x, y] = [pu / w, pv / h, px - cx, py - cy];
    for (const [row, rhs] of [
      [[x, y, 1, 0, 0, 0, -u * x, -u * y], u],
      [[0, 0, 0, x, y, 1, -v * x, -v * y], v],
    ] as const) {
      for (let i = 0; i < 8; i++) {
        atb[i] = (atb[i] ?? 0) + (row[i] ?? 0) * rhs;
        for (let j = 0; j < 8; j++) (ata[i] as number[])[j] = (ata[i]?.[j] ?? 0) + (row[i] ?? 0) * (row[j] ?? 0);
      }
    }
  }
  const m = solve(ata, atb);
  if (!m) return null;
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0, k = 0] = m;
  // 标定点在摄像头前方：其齐次坐标同号，取为正
  const [, , x0 = 0, y0 = 0] = calibration[0] ?? [];
  const sign = Math.sign(g * (x0 - cx) + k * (y0 - cy) + 1) || 1;
  return (px, py) => {
    const [x, y] = [px - cx, py - cy];
    const z = g * x + k * y + 1;
    return [(a * x + b * y + c) / z, (d * x + e * y + f) / z, sign * z];
  };
}

/** 按安装参数的针孔模型（与 GroundMapping.from_pose 同一约定：画面右方为平面 (−sin yaw, cos yaw)） */
export function pinhole(pose: CameraInfo["pose"], size: Point): Project {
  const yaw = (pose.yaw_deg * Math.PI) / 180;
  const pitch = (pose.pitch_deg * Math.PI) / 180;
  const forward = [Math.cos(pitch) * Math.cos(yaw), Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch)] as const;
  const right = [-Math.sin(yaw), Math.cos(yaw), 0] as const;
  // down = right × forward
  const down = [
    right[1] * forward[2] - right[2] * forward[1],
    right[2] * forward[0] - right[0] * forward[2],
    right[0] * forward[1] - right[1] * forward[0],
  ] as const;
  const fx = 0.5 / Math.tan((pose.hfov_deg * Math.PI) / 360); // 以画面宽为单位
  const fy = (fx * size[0]) / size[1];
  return (x, y) => {
    const d = [x - pose.x, y - pose.y, -pose.height_m] as const;
    const dot = (p: readonly [number, number, number]) => d[0] * p[0] + d[1] * p[1] + d[2] * p[2];
    const z = dot(forward);
    return [0.5 + (fx * dot(right)) / z, 0.5 + (fy * dot(down)) / z, z];
  };
}

/** 摄像头的地面映射；未标定也没有安装参数时为 null */
export function projector(camera: CameraInfo, size: Point): Project | null {
  if (camera.calibration.length >= MIN_POINTS) {
    const fitted = homography(camera.calibration, size);
    if (fitted) return fitted;
  }
  return camera.mapping === "none" ? null : pinhole(camera.pose, size);
}

/** 两平面点之间深度为 NEAR 处的点：深度在平面上是线性的（针孔为视线方向分量，单应为 w），按比例插值即准 */
function cut(p: Point, q: Point, dp: number, dq: number): Point {
  const t = (dp - NEAR) / (dp - dq);
  return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
}

/**
 * 平面折线或多边形投到画面：裁掉深度不足 NEAR 的部分（Sutherland–Hodgman），返回画面归一化坐标的若干段。
 * 多边形（closed）裁剪后仍是一个多边形；折线可能断成几段
 */
export function clip(points: readonly Point[], project: Project, closed: boolean): Point[][] {
  const depth = points.map(([x, y]) => project(x, y)[2]);
  const toImage = ([x, y]: Point): Point => {
    const [u, v] = project(x, y);
    return [u, v];
  };
  if (closed) {
    const out: Point[] = [];
    points.forEach((p, i) => {
      const j = (i + 1) % points.length;
      const q = points[j] as Point;
      const [dp, dq] = [depth[i] ?? 0, depth[j] ?? 0];
      if (dp >= NEAR) out.push(p);
      if (dp >= NEAR !== dq >= NEAR) out.push(cut(p, q, dp, dq));
    });
    return out.length >= 3 ? [out.map(toImage)] : [];
  }
  const runs: Point[][] = [];
  let run: Point[] = [];
  points.forEach((p, i) => {
    const dp = depth[i] ?? 0;
    if (dp >= NEAR) run.push(p);
    const q = points[i + 1];
    if (!q) return;
    const dq = depth[i + 1] ?? 0;
    if (dp >= NEAR && dq < NEAR) {
      run.push(cut(p, q, dp, dq));
      runs.push(run);
      run = [];
    } else if (dp < NEAR && dq >= NEAR) run.push(cut(p, q, dp, dq));
  });
  runs.push(run);
  return runs.filter((r) => r.length >= 2).map((r) => r.map(toImage));
}

/** 画面上要画的警戒线与规则区域（画面归一化坐标） */
export interface Zone {
  kind: "climb" | "intrusion" | "line_crossing";
  name: string;
  /** 区域为一个多边形；线可能被裁成几段 */
  paths: Point[][];
  /** 越线规则的正向箭头 [起点, 终点]（画面归一化坐标）；不限方向时为 null */
  arrow: [Point, Point] | null;
}

/** 越线箭头长度（米）：沿折线中段的左法向，forward 即从行进方向右侧穿到左侧 */
const ARROW_M = 0.6;

/** 一台摄像头的警戒线与规则区域；size 为画面像素宽高（视频未就绪时调用方不画） */
export function zones(camera: CameraInfo, size: Point): Zone[] {
  const [w, h] = size;
  const climb: Zone[] = (camera.climb_lines ?? []).map(([u1 = 0, v1 = 0, u2 = 0, v2 = 0]) => ({
    kind: "climb",
    name: "攀爬警戒线",
    paths: [
      [
        [u1 / w, v1 / h],
        [u2 / w, v2 / h],
      ],
    ],
    arrow: null,
  }));
  const project = projector(camera, size);
  if (!project) return climb;
  const rules = (camera.rules ?? []).flatMap((rule): Zone[] => {
    const points = rule.points.map(([x = 0, y = 0]) => [x, y] as const);
    const paths = clip(points, project, rule.type === "intrusion");
    if (paths.length === 0) return [];
    return [{ kind: rule.type, name: rule.name, paths, arrow: rule.type === "line_crossing" ? arrow(points, rule.direction, project) : null }];
  });
  return [...climb, ...rules];
}

function arrow(points: Point[], direction: string | undefined, project: Project): [Point, Point] | null {
  if (!direction || direction === "any") return null;
  const mid = Math.floor((points.length - 1) / 2);
  const [p, q] = [points[mid], points[mid + 1]];
  if (!p || !q) return null;
  const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
  if (len === 0) return null;
  // 俯视 x 向右、y 向下：行进方向 (dx, dy) 的左侧为 (dy, −dx)
  const sign = direction === "forward" ? 1 : -1;
  const [nx, ny] = [((q[1] - p[1]) / len) * sign, (-(q[0] - p[0]) / len) * sign];
  const from: Point = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
  const to: Point = [from[0] + nx * ARROW_M, from[1] + ny * ARROW_M];
  const [a, b] = [project(...from), project(...to)];
  return a[2] >= NEAR && b[2] >= NEAR ? [[a[0], a[1]], [b[0], b[1]]] : null;
}
