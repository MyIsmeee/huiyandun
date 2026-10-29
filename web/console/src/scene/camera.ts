import { useEffect, useLayoutEffect, useRef } from "react";
import { create } from "zustand";
import { useLive } from "../store/live";
import type { Camera } from "./devices";
import { blendShot, cameraShot, followShot, OVERVIEW, type Pose, type Shot, type Size, ZOOM_MAX, ZOOM_MIN } from "./layout";
import { positionAt, RENDER_DELAY_MS, turnToward } from "./targets";

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
}

export const useCamera = create<CameraState>()(() => ({ pose: OVERVIEW, goal: OVERVIEW, focus: null, flight: null, shot: null }));

/** 最近一次渲染的机位：飞行从这里出发，转场中被打断时不跳变（V-A2） */
let shown: Shot | null = null;

/**
 * 进入跟随视角，focus 为 null 时回到总览（总览重置为默认机位，V-I5）。
 * animate 为假时瞬时切换（降低动效、断线）；飞行中再次切换从当前机位出发，即可被打断
 */
export function focusOn(focus: Focus, animate: boolean): void {
  const flight = animate && shown ? { from: shown, start: performance.now() } : null;
  if (focus) {
    useCamera.setState({ focus, flight });
    return;
  }
  cancelAnimationFrame(frame);
  const home = overview(useCamera.getState().goal);
  useCamera.setState({ focus: null, flight, pose: home, goal: home, ...(flight ? {} : { shot: null }) });
}

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
 * 跟随的目标离开画面即飞回总览（D-058）。motion 为假时瞬时到位、停在最新实测位置
 */
export function useFocusShot(base: Shot | null, size: Size | null, cameras: Camera[], motion: boolean): Shot | null {
  const focus = useCamera((s) => s.focus);
  const flight = useCamera((s) => s.flight);
  const shot = useCamera((s) => s.shot);
  const bearing = useRef<{ key: string; angle: number; at: number } | null>(null);
  useEffect(() => {
    if (!focus && !flight) return;
    let frame = 0;
    const step = () => {
      const now = Date.now();
      let goal = base;
      let pending = false;
      if (size && focus?.kind === "camera") {
        const pose = cameras.find((c) => c.id === focus.id)?.pose;
        if (pose) goal = cameraShot(pose, size);
      }
      if (size && focus?.kind === "target") {
        const target = useLive.getState().targets[focus.key];
        if (!target) return focusOn(null, motion);
        const t = motion ? now - RENDER_DELAY_MS : Number.POSITIVE_INFINITY;
        const [x, y] = positionAt(target.trail, t);
        const camera = cameras.find((c) => c.id === target.camera_id)?.pose;
        const toCamera = camera && (camera.x !== x || camera.y !== y) ? Math.atan2(camera.y - y, camera.x - x) : 0;
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
        goal = followShot([x, y], angle, size);
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
  }, [base, size, cameras, focus, flight, motion]);
  const result = shot ?? base;
  useLayoutEffect(() => {
    shown = result;
  });
  return result;
}
