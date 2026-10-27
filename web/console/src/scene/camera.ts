import { create } from "zustand";
import { OVERVIEW, type Pose, ZOOM_MAX, ZOOM_MIN } from "./layout";

/** 相机转场时长，V-A2 要求 ≤ 600 ms */
export const TRANSITION_MS = 400;
/** 缩放档位：倍数为 2 的 level/2 次方，1、√2、2、2√2、4（ZOOM_MIN～ZOOM_MAX） */
const zoomLevel = (zoom: number) => Math.round(Math.log2(zoom) * 2);

interface CameraState {
  /** 当前姿态（转场中为插值） */
  pose: Pose;
  /** 目标姿态：按钮与拖拽都在此基础上计算 */
  goal: Pose;
}

export const useCamera = create<CameraState>()(() => ({ pose: OVERVIEW, goal: OVERVIEW }));

const easeOut = (t: number) => 1 - (1 - t) ** 3;
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

export function interpolate(from: Pose, to: Pose, t: number): Pose {
  return {
    azimuth: mix(from.azimuth, to.azimuth, t),
    zoom: mix(from.zoom, to.zoom, t),
    pan: [mix(from.pan[0], to.pan[0], t), mix(from.pan[1], to.pan[1], t)],
  };
}

let frame = 0;

/**
 * 移动相机到 goal。animate 为假时瞬时切换（降低动效、断线，V-A4、C-FE-05）；
 * 转场中再次移动从当前插值处出发，即可被用户操作打断（V-A2）。
 */
export function moveCamera(goal: Pose, animate: boolean): void {
  cancelAnimationFrame(frame);
  const from = useCamera.getState().pose;
  if (!animate) {
    useCamera.setState({ pose: goal, goal });
    return;
  }
  useCamera.setState({ goal });
  const start = performance.now();
  const step = (now: number) => {
    const t = Math.min(1, (now - start) / TRANSITION_MS);
    useCamera.setState({ pose: interpolate(from, goal, easeOut(t)) });
    if (t < 1) frame = requestAnimationFrame(step);
  };
  frame = requestAnimationFrame(step);
}

/** 放大或缩小一档；缩回总览倍数时取景回到中心 */
export function zoomed(goal: Pose, direction: 1 | -1): Pose {
  const level = Math.min(zoomLevel(ZOOM_MAX), Math.max(zoomLevel(ZOOM_MIN), zoomLevel(goal.zoom) + direction));
  const zoom = 2 ** (level / 2);
  return { ...goal, zoom, pan: zoom === ZOOM_MIN ? [0, 0] : goal.pan };
}

/** 旋转一档（90°）：direction 为 1 时场景顺时针转动；平移以画面为参照，旋转后归零 */
export function rotated(goal: Pose, direction: 1 | -1): Pose {
  return { ...goal, azimuth: goal.azimuth + (direction * Math.PI) / 2, pan: [0, 0] };
}

/** 返回总览（V-I5）：方位角回到最近的整圈，避免多转 */
export function overview(goal: Pose): Pose {
  return { ...OVERVIEW, azimuth: Math.round(goal.azimuth / (2 * Math.PI)) * 2 * Math.PI };
}

/** 拖拽平移：画面移动 (dx, dy) 像素，取景中心反向移动；不超出站点范围 */
export function panned(goal: Pose, [dx, dy]: readonly [number, number], zoom: number, limit: readonly [number, number]): Pose {
  const clamp = (v: number, max: number) => Math.min(max, Math.max(-max, v));
  return { ...goal, pan: [clamp(goal.pan[0] - dx / zoom, limit[0]), clamp(goal.pan[1] - dy / zoom, limit[1])] };
}
