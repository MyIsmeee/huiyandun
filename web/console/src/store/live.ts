import { create } from "zustand";
import type { components } from "../api/schema";

type Schemas = components["schemas"];
export type Device = Schemas["Device"];
export type Behavior = Schemas["VisionBehavior"];
export type RuleEvent = Schemas["VisionRule"];
type Track = Schemas["VisionTrack"];
export type SecurityAlert = Schemas["SecurityAlert"];
export type Incident = Schemas["incident.schema"];
export type Execution = Schemas["playbook_execution.schema"];
type AiFrame = Schemas["AiInvestigation"];
export type Site = Schemas["Site"];
export type Disposition = Schemas["AlertDisposition"];
type Cleared = Schemas["AlertsCleared"];
/** 告警列表的单条告警：网络告警、行为事件或轨迹规则事件（D-077） */
export type Alert = SecurityAlert | Behavior | RuleEvent;
/** 物理告警（行为事件与轨迹规则事件）带 camera_id，网络告警带 device_id */
export const isPhysical = (alert: Alert): alert is Behavior | RuleEvent => "camera_id" in alert;
/** 物理域关联事件（rules/correlator/HYD-VIS-*）：只引用画面与行为事件，没有攻击源、不触发封禁 */
export const isPhysicalIncident = (incident: Pick<Incident, "rule_id">) => incident.rule_id.startsWith("HYD-VIS-");
type Frame = Schemas["WsFrame"];

/** 告警列表与关联事件的保留条数，与连接补推的上限一致（D-077） */
export const MAX_ALERTS = 200;
export const MAX_INCIDENTS = 50;

/** 轨迹拖尾的固定时间窗（V-A5） */
export const TRAIL_MS = 10_000;
/** 超过此时长无位置更新即移除目标：已离开画面（V-U4） */
export const TRACK_TTL_MS = 2_000;

export type TargetClass = Track["object_class"];

/** 疑似行为（倒地满 2 s 等）在画面上提示此时长；确认后改为持续标记 */
export const SUSPECT_MARK_MS = 10_000;
/** 越线是瞬时事件，画面上标记此时长 */
export const PULSE_MARK_MS = 5_000;

/** 画面告警标记：触发行为或规则告警的人在监控墙画面上加框闪烁，标出行为与持续时长 */
export interface Mark {
  camera_id: string;
  track_id: number;
  kind: Behavior["behavior"] | RuleEvent["rule_type"];
  level: Behavior["level"];
  /** 规则名称（区域入侵、越线）；行为事件为 null */
  name: string | null;
  /** 状态开始的时刻（毫秒）：行为取开始时刻，区域取确认进入时刻，越线取越线时刻 */
  since: number;
  /** 到此时刻（毫秒）不再标记；null 为持续到行为解除或离开区域 */
  until: number | null;
  /** 收到的本地时刻：目标暂未出现时据此宽限 */
  seen: number;
}

/** 检出目标：人员或车辆（FR-102） */
export interface Target {
  camera_id: string;
  track_id: number;
  object_class: TargetClass;
  x: number;
  y: number;
  uncertainty_m: number;
  /** 运动方向，0 为平面 +x、自 +x 转向 +y 为正（俯视 y 向下时为顺时针）；静止或起步不足 3 帧时为 null */
  heading_deg: number | null;
  /** 平面速度（米每秒）；起步不足 3 帧时为 null */
  speed_mps: number | null;
  /** 最新一次实测的画面归一化检测框 [x1, y1, x2, y2] */
  bbox: Track["bbox"];
  /** 最新一次实测的 COCO 17 关键点 [u, v, score]，画面归一化；车辆为 null */
  keypoints: Track["keypoints"];
  /** 近 TRAIL_MS 内的位置 [x, y, 收到时刻]，按时间先后排列 */
  trail: (readonly [number, number, number])[];
}

interface LiveState {
  /** 摄像头登记表变化后推送的站点（D-101）；未推送过时为 null，取 GET /api/site 的初始值 */
  site: Site | null;
  /** 推送的设备最新状态，覆盖 GET /api/site 中的初始值 */
  devices: Record<string, Device>;
  /** 键为 "摄像头/track_id"：track_id 只在单个摄像头内唯一 */
  targets: Record<string, Target>;
  /** 每台摄像头最近一次进入物理告警的行为事件，供事件卡显示；疑似跌倒不进入物理告警，不记入 */
  behaviors: Record<string, Behavior>;
  /** 画面告警标记，键同 targets（"摄像头/track_id"） */
  marks: Record<string, Mark>;
  /** 各告警最近一次处置，键为 event_id */
  dispositions: Record<string, Disposition>;
  /** 单条告警，新的在前，按 event_id 去重（连接补推与实时转发可能重复） */
  alerts: Alert[];
  /** 关联事件，新的在前，按 id 去重 */
  incidents: Incident[];
  /** 处置执行的最新状态，键为执行 id；按最近更新排在最后 */
  executions: Record<string, Execution>;
  /** 每个执行各状态首次的事件时刻（ISO），供处置时间线（FR-304）；连接补推只含最新状态 */
  executionTimes: Record<string, Partial<Record<Execution["state"], string>>>;
  /** 每个关联事件最近一帧调查流的 seq：面板据此重新读取调查记录（调查记录先落库后推送） */
  aiSeq: Record<string, number>;
  /** 调查流已收到判定或失败帧的关联事件：时间线的"AI 判定"节点只在调查开始与结束时重读 */
  aiDone: Record<string, true>;
  /** 已删除（不再列出）的告警 event_id 与关联事件 id：之后补推或重复转发的同一条也不再列出 */
  cleared: { alerts: Record<string, true>; incidents: Record<string, true> };
}

/** 场景中的实时实体，全部来自 WS 推送（UP-1）；时刻一律取收到推送的本地时刻 */
export const useLive = create<LiveState>()(() => ({
  site: null,
  devices: {},
  targets: {},
  behaviors: {},
  marks: {},
  dispositions: {},
  alerts: [],
  incidents: [],
  executions: {},
  executionTimes: {},
  aiSeq: {},
  aiDone: {},
  cleared: { alerts: {}, incidents: {} },
}));

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
    const alerting = state === "physical_alert" || state === "both";
    useLive.setState((s) => ({
      devices: { ...s.devices, [id]: device },
      behaviors: drop(s.behaviors, id, alerting),
      // 行为告警解除即撤下画面标记；区域标记随规则事件的 end 撤下
      marks: alerting
        ? s.marks
        : Object.fromEntries(Object.entries(s.marks).filter(([, m]) => !(m.camera_id === id && m.until === null && !isRule(m.kind)))),
    }));
  }
  if (frame.channel === "site") applySite(data as Site);
  // alerts 频道同时承载行为事件（含 behavior 字段）、轨迹规则事件（含 rule_type）与网络告警；场景只用行为事件，告警等级随设备推送。
  // 区域告警的 update、end 只用于保持与解除物理告警，不另列为告警
  const lifecycle = frame.channel === "alerts" && "rule_type" in (data as object) && ["update", "end"].includes((data as RuleEvent).phase);
  if (frame.channel === "alerts" && !lifecycle) {
    const alert = data as Alert;
    useLive.setState((s) => ({
      alerts: s.alerts.some((a) => a.event_id === alert.event_id) || s.cleared.alerts[alert.event_id]
        ? s.alerts
        : [alert, ...s.alerts].sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, MAX_ALERTS),
    }));
  }
  if (frame.channel === "alerts" && "behavior" in (data as object) && (data as Behavior).level !== "suspected") {
    const behavior = data as Behavior;
    useLive.setState((s) => ({ behaviors: { ...s.behaviors, [behavior.camera_id]: behavior } }));
  }
  if (frame.channel === "alerts") mark(data as Alert, now);
  if (frame.channel === "dispositions") {
    const disposition = data as Disposition;
    useLive.setState((s) => ({ dispositions: { ...s.dispositions, [disposition.event_id]: disposition } }));
  }
  if (frame.channel === "cleared") {
    const { event_ids, incident_ids } = data as Cleared;
    const alerts = new Set(event_ids);
    const incidents = new Set(incident_ids);
    useLive.setState((s) => ({
      alerts: s.alerts.filter((a) => !alerts.has(a.event_id)),
      incidents: s.incidents.filter((i) => !incidents.has(i.id)),
      cleared: {
        alerts: { ...s.cleared.alerts, ...Object.fromEntries(event_ids.map((id) => [id, true as const])) },
        incidents: { ...s.cleared.incidents, ...Object.fromEntries(incident_ids.map((id) => [id, true as const])) },
      },
    }));
  }
  if (frame.channel === "incidents") {
    const incident = data as Incident;
    useLive.setState((s) => ({
      incidents: (s.cleared.incidents[incident.id] ? s.incidents : [incident, ...s.incidents.filter((i) => i.id !== incident.id)])
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .slice(0, MAX_INCIDENTS),
    }));
  }
  if (frame.channel === "executions") {
    const execution = data as Execution;
    // 推送的是 hyd.playbook.execution.v1，带事件时刻 ts
    const { ts } = data as { ts?: string };
    // 移到最后：遍历顺序即更新先后，设备取最近更新的执行
    useLive.setState((s) => {
      const rest = Object.fromEntries(Object.entries(s.executions).filter(([id]) => id !== execution.id));
      // 同一状态只记首次：执行器在已处置后还会推送拦截证据补注、解封失败等同状态更新，生效时刻不随之后移
      const known = s.executionTimes[execution.id];
      const times = ts && !known?.[execution.state] ? { ...known, [execution.state]: ts } : known;
      return {
        executions: { ...rest, [execution.id]: execution },
        executionTimes: times ? { ...s.executionTimes, [execution.id]: times } : s.executionTimes,
      };
    });
  }
  if (frame.channel === "ai") {
    const { incident_id, seq, kind } = data as AiFrame;
    useLive.setState((s) => ({
      aiSeq: { ...s.aiSeq, [incident_id]: seq },
      aiDone: kind === "step" ? s.aiDone : { ...s.aiDone, [incident_id]: true },
    }));
  }
}

/** 摄像头登记表变化后的站点（D-101）：site 频道推送，或断线重连后重新读取 */
export function applySite(site: Site): void {
  const ids = new Set(site.devices.map((d) => d.id));
  // 删除的摄像头连同其推送状态、事件卡与场景一并移除；新增与修改的以推送的站点为初始值
  const keep = <T,>(map: Record<string, T>) => Object.fromEntries(Object.entries(map).filter(([id]) => ids.has(id)));
  useLive.setState((s) => ({
    site,
    // 推送过的设备保留其当前状态，登记信息（名称、位置等）取新站点
    devices: Object.fromEntries(
      site.devices.map((d) => {
        const pushed = s.devices[d.id];
        return [d.id, pushed ? { ...d, state: pushed.state, alert_severity: pushed.alert_severity } : d];
      }),
    ),
    behaviors: keep(s.behaviors),
    marks: Object.fromEntries(Object.entries(s.marks).filter(([, m]) => ids.has(m.camera_id))),
    // 删除的摄像头的目标立即移除，不等 2 s 过期
    targets: Object.fromEntries(Object.entries(s.targets).filter(([, t]) => ids.has(t.camera_id))),
  }));
}

const isRule = (kind: Mark["kind"]) => kind === "intrusion" || kind === "line_crossing";

/** 按行为事件与规则事件更新画面告警标记 */
function mark(alert: Alert, now: number) {
  if (!isPhysical(alert)) return;
  const key = `${alert.camera_id}/${alert.track_id}`;
  const { camera_id, track_id, level } = alert;
  useLive.setState((s) => {
    const prev = s.marks[key];
    if ("rule_type" in alert && alert.phase === "end") {
      return prev?.kind === alert.rule_type ? { marks: drop(s.marks, key, false) } : {};
    }
    // 已确认、仍在持续的标记不被同一人的疑似事件覆盖
    if (level === "suspected" && prev?.level === "confirmed" && prev.until === null) return {};
    const next: Mark =
      "rule_type" in alert
        ? {
            camera_id,
            track_id,
            kind: alert.rule_type,
            level,
            name: alert.rule_name,
            since: Date.parse(alert.since) || now,
            until: alert.phase === "pulse" ? now + PULSE_MARK_MS : null,
            seen: now,
          }
        : {
            camera_id,
            track_id,
            kind: alert.behavior,
            level,
            name: null,
            since: Date.parse(alert.ts_start) || now,
            until: level === "suspected" ? now + SUSPECT_MARK_MS : null,
            seen: now,
          };
    return { marks: { ...s.marks, [key]: next } };
  });
}

function move(track: Track, now: number) {
  const { camera_id, track_id, object_class, x, y, uncertainty_m, heading_deg, speed_mps, bbox, keypoints } = track;
  const key = `${camera_id}/${track_id}`;
  useLive.setState((s) => {
    const trail = [...(s.targets[key]?.trail ?? []), [x, y, now] as const].filter(([, , t]) => t >= now - TRAIL_MS);
    const target: Target = { camera_id, track_id, object_class, x, y, uncertainty_m, heading_deg, speed_mps, bbox, keypoints, trail };
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
  // 到期的标记与已离开画面的人的标记撤下；行为事件可能早于该人的位置推送到达，宽限 TRACK_TTL_MS
  const { marks } = useLive.getState();
  const live = Object.entries(marks).filter(([key, m]) => (m.until === null || m.until > now) && (key in next || now - m.seen <= TRACK_TTL_MS));
  if (live.length !== Object.keys(marks).length) useLive.setState({ marks: Object.fromEntries(live) });
}
