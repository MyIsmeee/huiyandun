import { useEffect, useLayoutEffect, useRef } from "react";
import { create } from "zustand";
import { useLive } from "../store/live";
import type { Camera } from "./devices";
import { blendShot, cameraShot, FOLLOW_BASE_ELEVATION, FOLLOW_ELEVATION, followShot, OVERVIEW, type Pose, type Shot, type Size, ZOOM_MAX, ZOOM_MIN } from "./layout";
import { renderedPosition, renderTime } from "./smoothing";
import { turnToward } from "./targets";

/** 相机转场时长，V-A2 要求 ≤ 600 ms */
export const TRANSITION_MS = 400;
/** 缩放档位：倍数为 2 的 level/2 次方，1、√2、2、2√2、4（ZOOM_MIN～ZOOM_MAX） */
const zoomLevel = (zoom: number) => Math.round(Math.log2(zoom) * 2);

/** 飞入跟随视角、飞回总览的时长（设计 §3.5、V-A2） */
export const FLIGHT_MS = 600;
/** 跟随车辆时机位绕目标转动的角速度上限（弧度每秒）：车辆转弯时镜头平顺跟上 */
const FOLLOW_TURN_RATE = 1.5;

/** 跟随对象（V-I1）：人员或车辆（键为"摄像头/track_id"），或摄像头；null 为总览 */
export type Focus = { kind: "target"; key: string } | { kind: "camera"; id: string } | null;

interface CameraState {
  /** 当前姿态（转场中为插值） */
  pose: Pose;
  /** 目标姿态：按钮与拖拽都在此基础上计算 */
  goal: Pose;
  focus: Focus;
  /** 飞行中：从 from 出发，start 为开始时刻（performance.now） */
  flight: { from: Shot; start: number } | null;
  /** 跟随视角或飞行中的当前机位；null 为按总览姿态取景 */
  shot: Shot | null;
  /** 跟随视角下用户的调整（滚轮、拖拽）；每次进入或退出跟随都复位 */
  adjust: Adjust;
}

/**
 * 跟随视角的调整：turn 为绕目标转过的角度（弧度），distance 为距离倍数（摄像头视角下为视场倍数），
 * lift 为仰角增量（弧度）
 */
export interface Adjust {
  turn: number;
  distance: number;
  lift: number;
}
export const NO_ADJUST: Adjust = { turn: 0, distance: 1, lift: 0 };

export const useCamera = create<CameraState>()(() => ({
  pose: OVERVIEW,
  goal: OVERVIEW,
  focus: null,
  flight: null,
  shot: null,
  adjust: NO_ADJUST,
}));

/** 最近一次渲染的机位：飞行从这里出发，转场中被打断时不跳变（V-A2） */
let shown: Shot | null = null;

/**
 * 进入跟随视角，focus 为 null 时回到总览（总览重置为默认机位，V-I5）。
 * animate 为假时瞬时切换（降低动效、断线）；飞行中再次切换从当前机位出发，即可被打断
 */
export function focusOn(focus: Focus, animate: boolean): void {
  const flight = animate && shown ? { from: shown, start: performance.now() } : null;
  if (focus) {
    useCamera.setState({ focus, flight, adjust: NO_ADJUST });
    return;
  }
  cancelAnimationFrame(frame);
  const home = overview(useCamera.getState().goal);
  useCamera.setState({ focus: null, flight, pose: home, goal: home, adjust: NO_ADJUST, ...(flight ? {} : { shot: null }) });
}

const easeOut = (t: number) => 1 - (1 - t) ** 3;
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

export function interpolate(from: Pose, to: Pose, t: number): Pose {
  return {
    azimuth: mix(from.azimuth, to.azimuth, t),
    tilt: mix(from.tilt, to.tilt, t),
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

/** 旋转 90°（V-I5，与场景页一致）：场景在画面上顺时针转 90°；缩放保留，平移以画面为参照、旋转后归零 */
export function rotated(goal: Pose): Pose {
  return { ...goal, azimuth: goal.azimuth + Math.PI / 2, pan: [0, 0] };
}

/** 返回总览（V-I5）：方位角回到最近的整圈，避免多转 */
export function overview(goal: Pose): Pose {
  return { ...OVERVIEW, azimuth: Math.round(goal.azimuth / (2 * Math.PI)) * 2 * Math.PI };
}

/** 滚轮每像素（deltaY）的缩放指数：一格滚轮（约 100）缩放约 1.16 倍 */
const WHEEL_RATE = 0.0015;
/** 拖拽旋转：每像素转过的弧度 */
const DRAG_RATE = 0.006;
/** 总览俯角范围：不低到平视（看不见地面），不高到正上方（与 2D 俯视重复，且方位不定） */
export const TILT_RANGE = [(15 * Math.PI) / 180, (80 * Math.PI) / 180] as const;
/** 跟随距离倍数与摄像头视角的视场倍数范围 */
const ADJUST_DISTANCE = [0.35, 3] as const;
const clamp = (v: number, [lo, hi]: readonly [number, number]) => Math.min(hi, Math.max(lo, v));

/**
 * 滚轮缩放（总览）：deltaY 向下为正、缩小；以光标为中心——光标下的内容缩放前后不动。offset 为光标相对取景中心的像素，
 * pixelsPerMeter 为当前取景中心处每米像素数，limit 为平移上限；缩到最小时平移归零（与缩小按钮一致）
 */
export function wheelZoomed(
  goal: Pose,
  deltaY: number,
  offset: readonly [number, number],
  pixelsPerMeter: number,
  limit: readonly [number, number],
): Pose {
  const zoom = clamp(goal.zoom * Math.exp(-deltaY * WHEEL_RATE), [ZOOM_MIN, ZOOM_MAX]);
  if (zoom <= ZOOM_MIN) return { ...goal, zoom: ZOOM_MIN, pan: [0, 0] };
  const keep = 1 - goal.zoom / zoom; // 光标处的场景点：缩放前距取景中心 offset/ppm 米，缩放后要仍在光标下
  const shift = (i: 0 | 1) => clamp(goal.pan[i] + (offset[i] / pixelsPerMeter) * keep, [-limit[i], limit[i]]);
  return { ...goal, zoom, pan: [shift(0), shift(1)] };
}

/** 拖拽旋转（总览）：横向拖动改方位（向右拖时场景随手逆时针转），纵向拖动改俯角（向下拖时更接近俯视） */
export function orbited(goal: Pose, [dx, dy]: readonly [number, number]): Pose {
  return { ...goal, azimuth: goal.azimuth - dx * DRAG_RATE, tilt: clamp(goal.tilt + dy * DRAG_RATE, TILT_RANGE) };
}

/** 跟随视角下的滚轮：拉近、推远（摄像头视角下为收窄、放宽视场） */
export function adjustZoom(adjust: Adjust, deltaY: number): Adjust {
  return { ...adjust, distance: clamp(adjust.distance * Math.exp(deltaY * WHEEL_RATE), ADJUST_DISTANCE) };
}

/** 跟随视角下的拖拽：横向绕目标转动，纵向改仰角（向下拖时视点抬高） */
export function adjustOrbit(adjust: Adjust, [dx, dy]: readonly [number, number]): Adjust {
  const range = [FOLLOW_ELEVATION[0] - FOLLOW_BASE_ELEVATION, FOLLOW_ELEVATION[1] - FOLLOW_BASE_ELEVATION] as const;
  const lift = clamp(adjust.lift + dy * DRAG_RATE, range);
  return { ...adjust, turn: adjust.turn - dx * DRAG_RATE, lift };
}

/** 拖拽平移：画面移动 (dx, dy) 像素，取景中心反向移动；不超出站点范围 */
export function panned(goal: Pose, [dx, dy]: readonly [number, number], zoom: number, limit: readonly [number, number]): Pose {
  const clamp = (v: number, max: number) => Math.min(max, Math.max(-max, v));
  return { ...goal, pan: [clamp(goal.pan[0] - dx / zoom, limit[0]), clamp(goal.pan[1] - dy / zoom, limit[1])] };
}

/**
 * 视点一侧的摄像头：摄像头视角下为该摄像头；跟随人员时视点在其所属摄像头一侧，该摄像头挡在视线上（D-058）。
 * 它的模型与点选按钮不画
 */
export function useViewpointCamera(): string | null {
  const focus = useCamera((s) => s.focus);
  const person = useLive((s) => {
    const target = focus?.kind === "target" ? s.targets[focus.key] : undefined;
    return target?.object_class === "person" ? target.camera_id : null;
  });
  return focus?.kind === "camera" ? focus.id : person;
}

const sameShot = (a: Shot, b: Shot) => {
  const flat = (s: Shot) => [...s.eye, ...s.look, s.fov, ...s.center];
  const other = flat(b);
  return flat(a).every((v, i) => v === other[i]);
};

/**
 * 当前机位（V-I1）：总览为 base；跟随目标时视点随目标插值位置移动（与 TargetModels 同一渲染时间轴），
 * 车辆在车尾一侧、人员在所属摄像头一侧（人形姿态与画面一致，D-058）；摄像头视角在摄像头位置沿其朝向看出去。
 * 飞行中由出发机位向目标机位插值。只在飞行、目标移动或机位转动未完成时逐帧更新，静止时等下一次推送（V-A3）；
 * 跟随的目标离开画面即飞回总览（D-058）；聚焦的摄像头、或跟随目标所属的摄像头不在当前区域（被移出区域或删除）时同样退出，
 * 不留下"显示总览却禁用缩放旋转"的聚焦状态。motion 为假时瞬时到位、停在最新实测位置
 */
export function useFocusShot(base: Shot | null, size: Size | null, cameras: Camera[], motion: boolean): Shot | null {
  const focus = useCamera((s) => s.focus);
  const flight = useCamera((s) => s.flight);
  const shot = useCamera((s) => s.shot);
  const adjust = useCamera((s) => s.adjust);
  const bearing = useRef<{ key: string; angle: number; at: number } | null>(null);
  useEffect(() => {
    // 回到总览后再次跟随同一目标：机位按当时的位置重新取，不从上一次跟随结束时的方位转起
    if (!focus) bearing.current = null;
    if (!focus && !flight) return;
    let frame = 0;
    const step = () => {
      const now = Date.now();
      let goal = base;
      let pending = false;
      if (size && focus?.kind === "camera") {
        const pose = cameras.find((c) => c.id === focus.id)?.pose;
        if (!pose) return focusOn(null, motion);
        goal = cameraShot(pose, size);
        goal = { ...goal, fov: Math.min((150 * Math.PI) / 180, goal.fov * adjust.distance) };
      }
      if (size && focus?.kind === "target") {
        const target = useLive.getState().targets[focus.key];
        if (!target) return focusOn(null, motion);
        const t = renderTime(target, now, motion);
        const [x, y] = renderedPosition(focus.key, target, now, motion);
        const camera = cameras.find((c) => c.id === target.camera_id)?.pose;
        if (!camera) return focusOn(null, motion);
        const toCamera = camera.x !== x || camera.y !== y ? Math.atan2(camera.y - y, camera.x - x) : 0;
        const last = bearing.current?.key === focus.key ? bearing.current : null;
        // 车辆在车尾一侧（行进方向的反方向）；尚无朝向时保持上一帧，起始取摄像头一侧
        const desired =
          target.object_class === "person"
            ? toCamera
            : target.heading_deg === null
              ? (last?.angle ?? toCamera)
              : (target.heading_deg * Math.PI) / 180 + Math.PI;
        const dt = last ? Math.min((now - last.at) / 1000, 0.1) : 0;
        const angle = last && motion ? turnToward(last.angle, desired, FOLLOW_TURN_RATE * dt) : desired;
        bearing.current = { key: focus.key, angle, at: now };
        pending = motion && (t < (target.trail.at(-1)?.[2] ?? 0) || Math.abs(Math.sin((angle - desired) / 2)) > 1e-4);
        goal = followShot([x, y], angle + adjust.turn, size, adjust.distance, adjust.lift);
      }
      const progress = flight ? Math.min(1, (performance.now() - flight.start) / FLIGHT_MS) : 1;
      const next = flight && goal && progress < 1 ? blendShot(flight.from, goal, easeOut(progress)) : goal;
      const current = useCamera.getState().shot;
      if (!next || !current || !sameShot(next, current)) useCamera.setState({ shot: next });
      // 飞回总览到位：之后直接按总览姿态取景
      if (flight && progress >= 1) useCamera.setState(focus ? { flight: null } : { flight: null, shot: null });
      if (pending || (flight && progress < 1)) frame = requestAnimationFrame(step);
    };
    step();
    // 新推送到达时立即更新，并在仍有移动时续帧
    const unsubscribe = useLive.subscribe(() => {
      cancelAnimationFrame(frame);
      step();
    });
    return () => {
      cancelAnimationFrame(frame);
      unsubscribe();
    };
  }, [base, size, cameras, focus, flight, motion, adjust]);
  const result = shot ?? base;
  useLayoutEffect(() => {
    shown = result;
  });
  return result;
}
