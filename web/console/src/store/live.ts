import { create } from "zustand";
import type { components } from "../api/schema";

type Schemas = components["schemas"];
export type Device = Schemas["Device"];
export type Behavior = Schemas["VisionBehavior"];
type Alert = Schemas["SecurityAlert"];
export type Severity = Alert["severity"];
const RANK: Severity[] = ["low", "medium", "high", "critical"];
type Track = Schemas["VisionTrack"];
type Frame = Schemas["WsFrame"];

/** 轨迹拖尾的固定时间窗（V-A5） */
export const TRAIL_MS = 10_000;
/** 超过此时长无位置更新即移除化身：人已离开画面（V-U4） */
export const TRACK_TTL_MS = 2_000;

export interface Person {
  camera_id: string;
  track_id: number;
  x: number;
  y: number;
  uncertainty_m: number;
  /** 近 TRAIL_MS 内的位置 [x, y, 收到时刻]，按时间先后排列 */
  trail: (readonly [number, number, number])[];
}

interface LiveState {
  /** 推送的设备最新状态，覆盖 GET /api/site 中的初始值 */
  devices: Record<string, Device>;
  /** 键为 "摄像头/track_id"：track_id 只在单个摄像头内唯一 */
  people: Record<string, Person>;
  /** 每台摄像头最近一次行为事件，供事件卡显示 */
  behaviors: Record<string, Behavior>;
  /** 每台设备处于网络攻击期间收到的最高告警等级，决定视场是否呼吸（V-A1） */
  severities: Record<string, Severity>;
}

/** 场景中的实时实体，全部来自 WS 推送（UP-1）；时刻一律取收到推送的本地时刻 */
export const useLive = create<LiveState>()(() => ({ devices: {}, people: {}, behaviors: {}, severities: {} }));

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
    // 退出告警即清除对应记录：再次告警时事件卡不显示上一次的行为、不按旧 track_id 标记人员，告警等级重新累计
    useLive.setState((s) => ({
      devices: { ...s.devices, [id]: device },
      behaviors: drop(s.behaviors, id, state === "physical_alert" || state === "both"),
      severities: drop(s.severities, id, state === "cyber_alert" || state === "both"),
    }));
  }
  // alerts 频道同时承载行为事件（含 behavior 字段）与网络告警
  if (frame.channel === "alerts" && "behavior" in (data as object)) {
    const behavior = data as Behavior;
    useLive.setState((s) => ({ behaviors: { ...s.behaviors, [behavior.camera_id]: behavior } }));
  } else if (frame.channel === "alerts") {
    const { device_id, severity } = data as Alert;
    // 目标未登记为设备的告警不对应任何设备（FR-203）
    if (device_id === null) return;
    useLive.setState((s) => {
      const prev = s.severities[device_id];
      const max = prev && RANK.indexOf(prev) > RANK.indexOf(severity) ? prev : severity;
      return { severities: { ...s.severities, [device_id]: max } };
    });
  }
}

function move({ camera_id, track_id, x, y, uncertainty_m }: Track, now: number) {
  const key = `${camera_id}/${track_id}`;
  useLive.setState((s) => {
    const trail = [...(s.people[key]?.trail ?? []), [x, y, now] as const].filter(([, , t]) => t >= now - TRAIL_MS);
    return { people: { ...s.people, [key]: { camera_id, track_id, x, y, uncertainty_m, trail } } };
  });
}

/** 移除超时的化身并裁剪轨迹；无变化时不更新状态 */
export function prune(now: number): void {
  const { people } = useLive.getState();
  const next: Record<string, Person> = {};
  let changed = false;
  for (const [key, person] of Object.entries(people)) {
    const last = person.trail.at(-1)?.[2] ?? 0;
    if (last < now - TRACK_TTL_MS) {
      changed = true;
      continue;
    }
    const trail = person.trail.filter(([, , t]) => t >= now - TRAIL_MS);
    changed ||= trail.length !== person.trail.length;
    next[key] = trail.length === person.trail.length ? person : { ...person, trail };
  }
  if (changed) useLive.setState({ people: next });
}
