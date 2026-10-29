import type { Site } from "../lib/api";

/** 平面图坐标 (x, y) 映射为场景 (x, 0, y)：y 为竖直方向，单位米 */
export type Vec3 = readonly [number, number, number];
export type Size = { width: number; height: number };
type Point = readonly [number, number];

/** 总览取景计入的高度：墙体默认高度（设计 §3.2），站点边缘的立面不被裁出画面 */
export const WALL_HEIGHT_M = 2.8;
/** 地面与栅格的边长，以站点中心为中心：远超任何机位的可见范围，看不到边缘，即无限延伸的底面（§5.1 L0） */
export const GROUND_M = 1000;
/** 留出左上角 KPI 底板（§4.1 B 区）、底部断线提示（V-U3）与四周边距，单位像素 */
const INSET = { top: 112, right: 24, bottom: 56, left: 24 };

/**
 * 相机姿态（V-I1）：俯仰角与投影方式固定，只允许绕竖轴旋转、缩放与平移。
 * - azimuth：方位角（弧度），0 为默认的东南机位，增大时场景在画面上顺时针转动
 * - zoom：相对总览的倍数，1～4
 * - pan：取景中心沿画面向右、向下的偏移，单位米
 */
export interface Pose {
  azimuth: number;
  zoom: number;
  pan: Point;
}
export const OVERVIEW: Pose = { azimuth: 0, zoom: 1, pan: [0, 0] };
export const ZOOM_MIN = 1;
export const ZOOM_MAX = 4;

// V-I1：等距正交投影，默认相机位于 (+x, +y, +z) 方向俯视
const BACK: Vec3 = [1 / Math.sqrt(3), 1 / Math.sqrt(3), 1 / Math.sqrt(3)];
const RIGHT: Vec3 = [1 / Math.sqrt(2), 0, -1 / Math.sqrt(2)];
const UP: Vec3 = [-1 / Math.sqrt(6), 2 / Math.sqrt(6), -1 / Math.sqrt(6)];
const CAMERA_NEAR_M = 1;

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const along = (a: Vec3, axis: Vec3, k: number): Vec3 => [a[0] + axis[0] * k, a[1] + axis[1] * k, a[2] + axis[2] * k];
/** 绕竖轴旋转：相机绕站点逆时针（俯视）转动，场景在画面上顺时针转动 */
const turn = ([x, y, z]: Vec3, a: number): Vec3 => [
  x * Math.cos(a) + z * Math.sin(a),
  y,
  -x * Math.sin(a) + z * Math.cos(a),
];

export interface View {
  /** 每米对应的像素数 */
  zoom: number;
  /** 场景坐标 → 视口内像素坐标 */
  project: (p: Vec3) => Point;
  /** 平移上限：pan 各分量的绝对值不超过此值，取景中心不离开站点 */
  panLimit: Point;
}

export interface IsoView extends View {
  target: Vec3;
  position: Vec3;
  /** 相机可见深度范围，单位米 */
  near: number;
  far: number;
}

export interface PlanView extends View {
  /** SVG 变换：平面坐标 → 视口内像素坐标，与 project 一致 */
  transform: string;
}

function usable({ width, height }: Size) {
  return { width: width - INSET.left - INSET.right, height: height - INSET.top - INSET.bottom };
}

/** 等距视图：总览时站点包围盒（含墙高）完整落在视口可用区域内并居中；缩放以可用区域中心为锚点 */
export function isoView(site: Site, size: Size, pose: Pose = OVERVIEW): IsoView {
  const [back, right, up] = [turn(BACK, pose.azimuth), turn(RIGHT, pose.azimuth), turn(UP, pose.azimuth)];
  const corners: Vec3[] = [];
  for (const x of [0, site.width_m])
    for (const y of [0, WALL_HEIGHT_M]) for (const z of [0, site.height_m]) corners.push([x, y, z]);
  const center: Vec3 = [site.width_m / 2, 0, site.height_m / 2];
  const extent = (axis: Vec3) => corners.map((c) => dot(sub(c, center), axis));
  const [rs, us] = [extent(right), extent(up)];
  const [spanR, spanU] = [Math.max(...rs) - Math.min(...rs), Math.max(...us) - Math.min(...us)];
  const area = usable(size);
  const zoom = Math.min(area.width / spanR, area.height / spanU) * pose.zoom;
  // 包围盒投影的中点对齐可用区域的中点，再按 pan 偏移
  const r0 = (Math.max(...rs) + Math.min(...rs)) / 2 - (INSET.left - INSET.right) / 2 / zoom + pose.pan[0];
  const u0 = (Math.max(...us) + Math.min(...us)) / 2 + (INSET.top - INSET.bottom) / 2 / zoom - pose.pan[1];
  const target = along(along(center, right, r0), up, u0);
  // 包围盒各点沿视线方向距中心不超过半条对角线：相机退到一条对角线外，可见深度取其 2 倍
  const distance = Math.hypot(site.width_m, WALL_HEIGHT_M, site.height_m) + 10;
  const position = along(target, back, distance);
  return {
    zoom,
    target,
    position,
    near: CAMERA_NEAR_M,
    far: distance * 2,
    panLimit: [spanR / 2, spanU / 2],
    project: (p) => [
      size.width / 2 + zoom * dot(sub(p, target), right),
      size.height / 2 - zoom * dot(sub(p, target), up),
    ],
  };
}

/** 2D 俯视视图（C-FE-08 降级）：总览时 x 向右、y 向下，等比缩放、完整落在可用区域内并居中 */
export function planView(site: Site, size: Size, pose: Pose = OVERVIEW): PlanView {
  const [c, s] = [Math.cos(pose.azimuth), Math.sin(pose.azimuth)];
  const [w, h] = [site.width_m, site.height_m];
  // 旋转后站点外接矩形的宽高
  const [spanX, spanY] = [Math.abs(w * c) + Math.abs(h * s), Math.abs(w * s) + Math.abs(h * c)];
  const area = usable(size);
  const zoom = Math.min(area.width / spanX, area.height / spanY) * pose.zoom;
  const cx = INSET.left + area.width / 2 - zoom * pose.pan[0];
  const cy = INSET.top + area.height / 2 - zoom * pose.pan[1];
  return {
    zoom,
    panLimit: [spanX / 2, spanY / 2],
    // 画面 y 轴向下，正角度为顺时针
    project: ([x, , z]) => {
      const [vx, vz] = [x - w / 2, z - h / 2];
      return [cx + zoom * (vx * c - vz * s), cy + zoom * (vx * s + vz * c)];
    },
    transform: `translate(${cx} ${cy}) rotate(${(pose.azimuth * 180) / Math.PI}) scale(${zoom}) translate(${-w / 2} ${-h / 2})`,
  };
}
