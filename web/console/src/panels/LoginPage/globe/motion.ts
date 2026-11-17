/*
 * 登录页地球的纯计算部分：太阳直射点、缓动、俯冲时间线与布局。与 three.js 无关，单测直接覆盖。
 */

export const DEG = Math.PI / 180;
const TAU = Math.PI * 2;

/** 太阳直射点（弧度）。赤纬与时差用常见近似式，误差在一度以内（移植自 Voyage 后台 hero-globe） */
export function subsolarPoint(date: Date): { lat: number; lng: number } {
  const startOfYear = Date.UTC(date.getUTCFullYear(), 0, 0);
  const dayOfYear = (date.getTime() - startOfYear) / 86_400_000;
  const declination = -23.44 * Math.cos((TAU / 365) * (dayOfYear + 10));
  const b = (TAU / 364) * (dayOfYear - 81);
  const equationOfTime = 9.87 * Math.sin(2 * b) - 7.53 * Math.cos(b) - 1.5 * Math.sin(b);
  const utcHours = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
  let lng = (12 - utcHours - equationOfTime / 60) * 15;
  lng = ((((lng + 180) % 360) + 360) % 360) - 180;
  return { lat: declination * DEG, lng: lng * DEG };
}

/** 浏览器时区的中央经线（弧度） */
export function localZoneLongitude(date: Date): number {
  return (-date.getTimezoneOffset() / 60) * 15 * DEG;
}

export const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** t 在 [a, b] 内的归一化进度 */
export const span = (t: number, a: number, b: number) => clamp01((t - a) / (b - a));
export const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
export const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
export const easeInCubic = (t: number) => t * t * t;
export const easeOutQuart = (t: number) => 1 - Math.pow(1 - t, 4);
export const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/**
 * 三次 Hermite：从 p0 以初速度 v0（每单位归一化时间的增量）出发，速度归零地停在 p1。
 * 俯冲开始时地球正在自转，用它接上原有转速，不会先停一下再转。
 */
export function hermite(p0: number, v0: number, p1: number, s: number): number {
  const s2 = s * s;
  const s3 = s2 * s;
  return (2 * s3 - 3 * s2 + 1) * p0 + (s3 - 2 * s2 + s) * v0 + (-2 * s3 + 3 * s2) * p1;
}

/** 与 target 同余（模 2π）、且比 from 至少大 minTurn 的最近角度：沿自转方向继续转过去，不倒转 */
export function forwardAngle(from: number, target: number, minTurn = 0): number {
  return target + Math.ceil((from + minTurn - target) / TAU) * TAU;
}

/**
 * 俯冲时间线（秒）。各段互相重叠，前一段减速时后一段已经起步，整体是一条连续的镜头：
 * 表单退场 → 地球移到中央并放大、目标区域转到正面 → 对数高度下降穿过云层 → 控制台从下方淡入。
 */
export const DIVE = {
  /** 摄像头、覆盖弧淡出 */
  overlayOut: [0, 0.4],
  /** 地球从左侧移到中央并放大 */
  center: [0, 1.15],
  /** 目标区域转到正面 */
  align: [0, 1.35],
  /** 太阳转到镜头一侧，目标区域即使正值夜间也被照亮 */
  sun: [0.1, 1.45],
  /** 锁定框出现与消失 */
  reticleIn: [0.3, 0.75],
  reticleOut: [1.85, 2.25],
  /** 高度按对数下降：高空时快、贴近地面时减速 */
  descend: [0.75, 2.8],
  /** 视场角放宽，贴地时有速度感与地表弧度 */
  widen: [1.55, 2.8],
  /** 挂载控制台（不透明度 0，在登录层下方） */
  reveal: 2.05,
  /** 登录层淡出并继续推进，露出控制台 */
  fade: [2.2, 3.0],
  total: 3.0,
} as const;

/** 静止时的高度（球半径为 1）与俯冲终点高度 */
export const REST_DISTANCE = 4.15;
export const FINAL_ALTITUDE = 0.012;

/**
 * 俯冲第 t 秒的镜头高度（起点高度 h0）：在对数空间里插值，每一帧缩放的比例相同，像从高空一路扎下去；
 * 再套一层缓入缓出，起步接上居中放大、落地前减速
 */
export function diveAltitude(t: number, h0 = REST_DISTANCE - 1): number {
  const e = easeInOutCubic(span(t, DIVE.descend[0], DIVE.descend[1]));
  return h0 * Math.pow(FINAL_ALTITUDE / h0, e);
}

export const SPLIT_MIN_WIDTH = 1024;
/** 登录卡片宽度，与 LoginPage 的 w-[420px] 一致（取自 Voyage 后台登录卡片） */
export const CARD_WIDTH = 420;
/** 左上角品牌与摄像头、左下角标语各自占用的高度 */
const TOP_RESERVE = 120;
const BOTTOM_RESERVE = 176;
/** 覆盖弧外缘到球心的距离（球半径为 1） */
const ARC_REACH = 1.22;
/** 卡片左缘到球心的距离：压在地球右侧辉光与轨道环上，毛玻璃底下透出地球 */
const CARD_OFFSET = 1.02;

export interface RestLayout {
  cx: number;
  cy: number;
  radius: number;
  split: boolean;
  /** 宽屏时登录卡片左缘（像素） */
  cardLeft: number;
}

/**
 * 静止时地球的位置与半径（像素）。宽屏时「地球 + 卡片」作为一组水平居中，卡片左缘压在地球右侧；
 * 窄屏时地球居中垫在表单下方
 */
export function restLayout(width: number, height: number): RestLayout {
  if (width >= SPLIT_MIN_WIDTH) {
    const area = Math.max(240, height - TOP_RESERVE - BOTTOM_RESERVE);
    const span = ARC_REACH + CARD_OFFSET; // 左侧覆盖弧外缘到卡片左缘，以半径计
    const radius = Math.max(120, Math.min(area / 2 / ARC_REACH, (width - CARD_WIDTH - 240) / span));
    const cardLeft = Math.round((width + span * radius - CARD_WIDTH) / 2);
    return { cx: cardLeft - CARD_OFFSET * radius, cy: TOP_RESERVE + area / 2, radius, split: true, cardLeft };
  }
  return { cx: width / 2, cy: height / 2, radius: Math.min(width, height) * 0.4, split: false, cardLeft: 0 };
}

/** 镜头距球心 distance 时，球的轮廓在屏幕上的半径为 radius 像素所需的垂直视场角（度） */
export function fovForRadius(distance: number, radius: number, height: number): number {
  const tanAngular = 1 / Math.sqrt(distance * distance - 1);
  return (2 * Math.atan((tanAngular * height) / 2 / radius)) / DEG;
}

/** 反过来：给定视场角时球轮廓的屏幕半径（像素） */
export function radiusForFov(distance: number, fov: number, height: number): number {
  const tanAngular = 1 / Math.sqrt(distance * distance - 1);
  return (tanAngular / Math.tan((fov * DEG) / 2)) * (height / 2);
}
