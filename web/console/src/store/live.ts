import { create } from "zustand";
import type { components } from "../api/schema";

type Schemas = components["schemas"];
export type Device = Schemas["Device"];
export type Behavior = Schemas["VisionBehavior"];
type Track = Schemas["VisionTrack"];
export type SceneFrame = Schemas["VisionScene"];
type Frame = Schemas["WsFrame"];

/** 轨迹拖尾的固定时间窗（V-A5） */
export const TRAIL_MS = 10_000;
/** 超过此时长无位置更新即移除目标：已离开画面（V-U4） */
export const TRACK_TTL_MS = 2_000;

export type TargetClass = Track["object_class"];

/** 检出目标：人员或车辆（FR-102） */
export interface Target {
  camera_id: string;
  track_id: number;
  object_class: TargetClass;
  x: number;
  y: number;
  uncertainty_m: number;
  /** 运动方向，0 为平面 +x、逆时针为正；静止或起步不足 3 帧时为 null */
  heading_deg: number | null;
  /** 近 TRAIL_MS 内的位置 [x, y, 收到时刻]，按时间先后排列 */
  trail: (readonly [number, number, number])[];
}

interface LiveState {
  /** 推送的设备最新状态，覆盖 GET /api/site 中的初始值 */
  devices: Record<string, Device>;
  /** 键为 "摄像头/track_id"：track_id 只在单个摄像头内唯一 */
  targets: Record<string, Target>;
  /** 每台摄像头最近一次行为事件，供事件卡显示 */
  behaviors: Record<string, Behavior>;
  /** 每台摄像头最新一帧识别的环境（FR-108） */
  scenes: Record<string, SceneFrame>;
}

/** 场景中的实时实体，全部来自 WS 推送（UP-1）；时刻一律取收到推送的本地时刻 */
export const useLive = create<LiveState>()(() => ({ devices: {}, targets: {}, behaviors: {}, scenes: {} }));

/** keep 为假时去掉 id 对应的项 */
const drop = <T,>(map: Record<string, T>, id: string, keep: boolean) =>
  keep ? map : Object.fromEntries(Object.entries(map).filter(([key]) => key !== id));

/** 按契约 WsFrame 的频道说明解析推送；场景不使用的频道忽略 */
export function receive(frame: Frame, now: number): void {
  const data = frame.data as unknown;
  if (frame.channel === "tracks") move(data as Track, now);
  if (frame.channel === "devices") {
    const device = data as Device;
    const { id, state } = device;
    // 退出物理告警即清除行为事件：再次告警时事件卡不显示上一次的行为、不按旧 track_id 标记人员
    useLive.setState((s) => ({
      devices: { ...s.devices, [id]: device },
      behaviors: drop(s.behaviors, id, state === "physical_alert" || state === "both"),
    }));
  }
  if (frame.channel === "scene") {
    const scene = data as SceneFrame;
    useLive.setState((s) => ({ scenes: { ...s.scenes, [scene.camera_id]: scene } }));
  }
  // alerts 频道同时承载行为事件（含 behavior 字段）与网络告警；场景只用行为事件，告警等级随设备推送
  if (frame.channel === "alerts" && "behavior" in (data as object)) {
    const behavior = data as Behavior;
    useLive.setState((s) => ({ behaviors: { ...s.behaviors, [behavior.camera_id]: behavior } }));
  }
}

function move({ camera_id, track_id, object_class, x, y, uncertainty_m, heading_deg }: Track, now: number) {
  const key = `${camera_id}/${track_id}`;
  useLive.setState((s) => {
    const trail = [...(s.targets[key]?.trail ?? []), [x, y, now] as const].filter(([, , t]) => t >= now - TRAIL_MS);
    const target: Target = { camera_id, track_id, object_class, x, y, uncertainty_m, heading_deg, trail };
    return { targets: { ...s.targets, [key]: target } };
  });
}

/** 移除超时的目标并裁剪轨迹；无变化时不更新状态 */
export function prune(now: number): void {
  const { targets } = useLive.getState();
  const next: Record<string, Target> = {};
  let changed = false;
  for (const [key, target] of Object.entries(targets)) {
    const last = target.trail.at(-1)?.[2] ?? 0;
    if (last < now - TRACK_TTL_MS) {
      changed = true;
      continue;
    }
    const trail = target.trail.filter(([, , t]) => t >= now - TRAIL_MS);
    changed ||= trail.length !== target.trail.length;
    next[key] = trail.length === target.trail.length ? target : { ...target, trail };
  }
  if (changed) useLive.setState({ targets: next });
}
