import type { Vec3 } from "./layout";

/**
 * 场景光照随浏览器本地时间变化（HYD-UIX-004 §5.1 光照、V-A6）。
 * 只改变明暗与阴影方向，光色恒为白色，不改变表面色相（V-S2）。
 * 平面图按上北下南理解：x 向东、y 向南；太阳从东（+x）经南（+y）落向西（-x）。
 */
export interface Lighting {
  /** 由场景指向主光源的单位向量：白天为太阳，夜间为月光 */
  direction: Vec3;
  /** 主光强度 */
  sun: number;
  /** 环境光强度 */
  ambient: number;
  /** 地面阴影不透明度 */
  shadowOpacity: number;
}

const STEP_MIN = 10;
const SUNRISE_H = 6;
const SUNSET_H = 18;
const NOON_ELEVATION_DEG = 60;
const HORIZON_ELEVATION_DEG = 5;
const rad = (deg: number) => (deg * Math.PI) / 180;

// 夜间月光：西南方向、高度角 40°，低强度，阴影很淡
const MOON: Lighting = {
  direction: [-Math.cos(rad(40)) / Math.SQRT2, Math.sin(rad(40)), Math.cos(rad(40)) / Math.SQRT2],
  sun: 0.4,
  ambient: 0.7,
  shadowOpacity: 0.12,
};

/** 当天的分钟数，按 10 分钟步进取整：光照每 10 分钟瞬时切换一次（V-A6） */
export function lightStep(date: Date): number {
  const minutes = date.getHours() * 60 + date.getMinutes();
  return minutes - (minutes % STEP_MIN);
}

export function lightingAt(minutes: number): Lighting {
  const hours = minutes / 60;
  if (hours < SUNRISE_H || hours >= SUNSET_H) return MOON;
  const azimuth = ((hours - SUNRISE_H) / (SUNSET_H - SUNRISE_H)) * Math.PI; // 0 东 → π/2 南 → π 西
  const elevation = rad(HORIZON_ELEVATION_DEG + (NOON_ELEVATION_DEG - HORIZON_ELEVATION_DEG) * Math.sin(azimuth));
  const strength = Math.sin(elevation) / Math.sin(rad(NOON_ELEVATION_DEG)); // 清晨傍晚弱、正午为 1
  return {
    direction: [
      Math.cos(azimuth) * Math.cos(elevation),
      Math.sin(elevation),
      Math.sin(azimuth) * Math.cos(elevation),
    ],
    sun: 0.8 + 1.4 * strength,
    ambient: 1 + 0.4 * strength,
    shadowOpacity: 0.3,
  };
}
