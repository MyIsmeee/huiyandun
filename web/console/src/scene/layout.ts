import type { Site } from "../lib/api";

/** 平面图坐标 (x, y) 映射为场景 (x, 0, y)：y 为竖直方向，单位米 */
export type Vec3 = readonly [number, number, number];
export type Size = { width: number; height: number };
type Point = readonly [number, number];

/** 墙体实体高度（§5.1 L1）；近侧墙体半透明，不遮挡室内 */
export const WALL_HEIGHT_M = 2.8;
export const WALL_THICKNESS_M = 0.2;
/** 留出左上角 KPI 底板（§4.1 B 区）、底部断线提示（V-U3）与四周边距，单位像素 */
const INSET = { top: 112, right: 24, bottom: 56, left: 24 };

// V-I1：等距正交投影，相机位于 (+x, +y, +z) 方向俯视
const BACK: Vec3 = [1 / Math.sqrt(3), 1 / Math.sqrt(3), 1 / Math.sqrt(3)];
const RIGHT: Vec3 = [1 / Math.sqrt(2), 0, -1 / Math.sqrt(2)];
const UP: Vec3 = [-1 / Math.sqrt(6), 2 / Math.sqrt(6), -1 / Math.sqrt(6)];
const CAMERA_NEAR_M = 1;

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const along = (a: Vec3, axis: Vec3, k: number): Vec3 => [a[0] + axis[0] * k, a[1] + axis[1] * k, a[2] + axis[2] * k];

export interface View {
  /** 每米对应的像素数 */
  zoom: number;
  /** 场景坐标 → 视口内像素坐标 */
  project: (p: Vec3) => Point;
}

export interface IsoView extends View {
  target: Vec3;
  position: Vec3;
  /** 相机可见深度范围，单位米 */
  near: number;
  far: number;
}

function usable({ width, height }: Size) {
  return { width: width - INSET.left - INSET.right, height: height - INSET.top - INSET.bottom };
}

/** 等距视图：站点包围盒（含墙高）完整落在视口可用区域内并居中 */
export function isoView(site: Site, size: Size): IsoView {
  const corners: Vec3[] = [];
  for (const x of [0, site.width_m])
    for (const y of [0, WALL_HEIGHT_M]) for (const z of [0, site.height_m]) corners.push([x, y, z]);
  const center: Vec3 = [site.width_m / 2, 0, site.height_m / 2];
  const extent = (axis: Vec3) => corners.map((c) => dot(sub(c, center), axis));
  const [rs, us] = [extent(RIGHT), extent(UP)];
  const area = usable(size);
  const zoom = Math.min(
    area.width / (Math.max(...rs) - Math.min(...rs)),
    area.height / (Math.max(...us) - Math.min(...us)),
  );
  // 包围盒投影的中点对齐可用区域的中点
  const r0 = (Math.max(...rs) + Math.min(...rs)) / 2 - (INSET.left - INSET.right) / 2 / zoom;
  const u0 = (Math.max(...us) + Math.min(...us)) / 2 + (INSET.top - INSET.bottom) / 2 / zoom;
  const target = along(along(center, RIGHT, r0), UP, u0);
  // 包围盒各点沿视线方向距中心不超过半条对角线：相机退到一条对角线外，可见深度取其 2 倍
  const distance = Math.hypot(site.width_m, WALL_HEIGHT_M, site.height_m) + 10;
  const position = along(target, BACK, distance);
  return {
    zoom,
    target,
    position,
    near: CAMERA_NEAR_M,
    far: distance * 2,
    project: (p) => [
      size.width / 2 + zoom * dot(sub(p, target), RIGHT),
      size.height / 2 - zoom * dot(sub(p, target), UP),
    ],
  };
}

/** 2D 俯视平面图（C-FE-08 降级）：x 向右、y 向下，完整落在可用区域内并居中 */
export function planView(site: Site, size: Size): View {
  const area = usable(size);
  const zoom = Math.min(area.width / site.width_m, area.height / site.height_m);
  const left = INSET.left + (area.width - zoom * site.width_m) / 2;
  const top = INSET.top + (area.height - zoom * site.height_m) / 2;
  return {
    zoom,
    project: ([x, , z]) => [left + zoom * x, top + zoom * z],
  };
}

/** 区域名称标注位置：多边形顶点均值 */
export function zoneAnchor(polygon: number[][]): Vec3 {
  let [x, y] = [0, 0];
  for (const [px = 0, py = 0] of polygon) [x, y] = [x + px, y + py];
  return [x / polygon.length, 0, y / polygon.length];
}

export function zoneLabel(zone: Site["zones"][number]): string {
  return zone.no_climb ? `${zone.name} · 禁止攀爬` : zone.name;
}

export function isEmpty(site: Site): boolean {
  return site.walls.length === 0 && site.zones.length === 0;
}
