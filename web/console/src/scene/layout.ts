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

// V-I1：透视总览，俯角 45°，默认相机位于 (+x, +y, +z) 方向
const BACK: Vec3 = [0.5, Math.SQRT1_2, 0.5];
const RIGHT: Vec3 = [Math.SQRT1_2, 0, -Math.SQRT1_2];
const UP: Vec3 = [-0.5, Math.SQRT1_2, -0.5];
/** 总览的竖直视场角：视场越小越接近等距，越大近大远小越明显 */
const OVERVIEW_FOV = (35 * Math.PI) / 180;
const CAMERA_NEAR_M = 0.5;

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const along = (a: Vec3, axis: Vec3, k: number): Vec3 => [a[0] + axis[0] * k, a[1] + axis[1] * k, a[2] + axis[2] * k];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: Vec3): Vec3 => along([0, 0, 0], a, 1 / Math.hypot(...a));
/** 绕竖轴旋转：相机绕站点逆时针（俯视）转动，场景在画面上顺时针转动 */
const turn = ([x, y, z]: Vec3, a: number): Vec3 => [
  x * Math.cos(a) + z * Math.sin(a),
  y,
  -x * Math.sin(a) + z * Math.cos(a),
];

export interface View {
  /** 每米对应的像素数；透视视图为取景中心处 */
  zoom: number;
  /** 场景坐标 → 视口内像素坐标；在相机近裁面以内或身后的点为 null */
  project: (p: Vec3) => Point | null;
  /** 该点处每米对应的像素数：透视视图近大远小 */
  scale: (p: Vec3) => number;
  /** 平移上限：pan 各分量的绝对值不超过此值，取景中心不离开站点 */
  panLimit: Point;
}

/** 透视机位：视点、取景中心、竖直视场角（弧度），取景中心落在视口内 center 像素处 */
export interface Shot {
  eye: Vec3;
  look: Vec3;
  fov: number;
  center: Point;
}

export interface SceneView extends View {
  shot: Shot;
  /** 相机可见深度范围，单位米 */
  near: number;
  far: number;
}

export interface PlanView extends View {
  /** 俯视平面上每个点都可见 */
  project: (p: Vec3) => Point;
  /** SVG 变换：平面坐标 → 视口内像素坐标，与 project 一致 */
  transform: string;
}

function usable({ width, height }: Size) {
  return { width: width - INSET.left - INSET.right, height: height - INSET.top - INSET.bottom };
}

/** 透视视图：按机位把场景投影到视口，与 Scene3D 的透视相机一致（竖直视场 fov、取景中心在 center 像素处） */
export function sceneView(shot: Shot, size: Size, panLimit: Point = [0, 0]): SceneView {
  const { eye, look, fov, center } = shot;
  const back = unit(sub(eye, look));
  const right = unit(cross([0, 1, 0], back));
  const up = cross(back, right);
  const focal = size.height / 2 / Math.tan(fov / 2);
  const depth = (p: Vec3) => -dot(sub(p, eye), back);
  return {
    shot,
    zoom: focal / Math.hypot(...sub(eye, look)),
    near: CAMERA_NEAR_M,
    far: GROUND_M,
    panLimit,
    scale: (p) => focal / Math.max(depth(p), CAMERA_NEAR_M),
    project: (p) => {
      const d = depth(p);
      if (d <= CAMERA_NEAR_M) return null;
      const v = sub(p, eye);
      return [center[0] + (focal * dot(v, right)) / d, center[1] - (focal * dot(v, up)) / d];
    },
  };
}

/**
 * 透视总览（V-I1）：俯角 45°，取景中心为站点中心、对准可用区域中心；视点退到站点包围盒（含墙高）完整落在可用区域内的最近处。
 * 缩放按倍数拉近视点；平移在画面平面内移动相机，与取景中心同深度的内容每米移动 zoom 像素
 */
export function overviewShot(site: Site, size: Size, pose: Pose = OVERVIEW): { shot: Shot; panLimit: Point } {
  const [back, right, up] = [turn(BACK, pose.azimuth), turn(RIGHT, pose.azimuth), turn(UP, pose.azimuth)];
  const center: Vec3 = [site.width_m / 2, 0, site.height_m / 2];
  const offsets: Vec3[] = [];
  for (const x of [0, site.width_m])
    for (const y of [0, WALL_HEIGHT_M]) for (const z of [0, site.height_m]) offsets.push(sub([x, y, z], center));
  const area = usable(size);
  const focal = size.height / 2 / Math.tan(OVERVIEW_FOV / 2);
  // 角点沿视线方向比中心近 b、深度为 distance - b：横向与纵向都不超出可用区域的半宽、半高
  const fit = Math.max(
    ...offsets.map((v) => {
      const b = dot(v, back);
      return Math.max(b + (focal * Math.abs(dot(v, right))) / (area.width / 2), b + (focal * Math.abs(dot(v, up))) / (area.height / 2));
    }),
  );
  const look = along(along(center, right, pose.pan[0]), up, -pose.pan[1]);
  const span = (axis: Vec3) => Math.max(...offsets.map((v) => Math.abs(dot(v, axis))));
  return {
    shot: {
      eye: along(look, back, fit / pose.zoom),
      look,
      fov: OVERVIEW_FOV,
      center: [INSET.left + area.width / 2, INSET.top + area.height / 2],
    },
    panLimit: [span(right), span(up)],
  };
}

/** 跟随视角（设计 §3.5）：视点距目标水平 8 m、高 4 m，俯角 25°；视场比总览宽，近似车机跟车 */
const FOLLOW = { back: 8, height: 4, pitch: (25 * Math.PI) / 180, fov: (45 * Math.PI) / 180 };

/** 跟随机位：视点在目标 (x, y) 沿平面方向 bearing（弧度，由 +x 转向 +y）一侧，朝目标看去，取景中心为视口中心 */
export function followShot([x, y]: Point, bearing: number, size: Size): Shot {
  const [dx, dy] = [Math.cos(bearing), Math.sin(bearing)];
  const eye: Vec3 = [x + dx * FOLLOW.back, FOLLOW.height, y + dy * FOLLOW.back];
  const reach = FOLLOW.height / Math.tan(FOLLOW.pitch); // 视线落地处距视点的水平距离
  return { eye, look: [eye[0] - dx * reach, 0, eye[2] - dy * reach], fov: FOLLOW.fov, center: [size.width / 2, size.height / 2] };
}

type CameraPose = { x: number; y: number; height_m: number; yaw_deg: number; pitch_deg: number; hfov_deg: number };

/** 摄像头视角：视点在摄像头安装位置，沿其朝向与俯仰看出去，水平视场与摄像头一致 */
export function cameraShot(pose: CameraPose, size: Size): Shot {
  const [yaw, pitch] = [(pose.yaw_deg * Math.PI) / 180, (pose.pitch_deg * Math.PI) / 180];
  const eye: Vec3 = [pose.x, pose.height_m, pose.y];
  const direction: Vec3 = [Math.cos(pitch) * Math.cos(yaw), Math.sin(pitch), Math.cos(pitch) * Math.sin(yaw)];
  const fov = 2 * Math.atan((Math.tan((pose.hfov_deg * Math.PI) / 360) * size.height) / size.width);
  return { eye, look: along(eye, direction, 10), fov, center: [size.width / 2, size.height / 2] };
}

/** 两个机位之间按 t（0～1）插值：飞入、飞回的转场 */
export function blendShot(a: Shot, b: Shot, t: number): Shot {
  const mix = (p: number, q: number) => p + (q - p) * t;
  const mix3 = (p: Vec3, q: Vec3): Vec3 => [mix(p[0], q[0]), mix(p[1], q[1]), mix(p[2], q[2])];
  return {
    eye: mix3(a.eye, b.eye),
    look: mix3(a.look, b.look),
    fov: mix(a.fov, b.fov),
    center: [mix(a.center[0], b.center[0]), mix(a.center[1], b.center[1])],
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
    scale: () => zoom,
    // 画面 y 轴向下，正角度为顺时针
    project: ([x, , z]) => {
      const [vx, vz] = [x - w / 2, z - h / 2];
      return [cx + zoom * (vx * c - vz * s), cy + zoom * (vx * s + vz * c)];
    },
    transform: `translate(${cx} ${cy}) rotate(${(pose.azimuth * 180) / Math.PI}) scale(${zoom}) translate(${-w / 2} ${-h / 2})`,
  };
}
