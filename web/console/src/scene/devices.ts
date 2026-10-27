import { useMemo } from "react";
import { type Device, useLive } from "../store/live";

/** §3.2 状态色：语义固定、全系统唯一（V-S2） */
export const STATUS = {
  neutral: "#6E7A8A",
  uncertain: "#898781",
  physical: "#FAB219",
  cyber: "#D03B3B",
  contained: "#0CA30C",
} as const;

export type DeviceState = Device["state"];
export type Camera = {
  id: string;
  state: DeviceState;
  /** 标定点不少于 4 组（FR-902）；与 state 无关，处于告警的摄像头同样可能未标定 */
  calibrated: boolean;
  /** 处于网络攻击期间收到过 critical / high 告警：只有此时视场呼吸（V-A1） */
  severe: boolean;
  pose: NonNullable<Device["camera"]>["pose"];
};

/** 场景中的摄像头：状态以推送为准，未推送过的取 GET /api/site 的初始值；M0 站点只导入摄像头 */
export function useCameras(devices: Device[]): Camera[] {
  const pushed = useLive((s) => s.devices);
  const severities = useLive((s) => s.severities);
  return useMemo(
    () =>
      devices.flatMap((initial) => {
        const { id, state, camera } = pushed[initial.id] ?? initial;
        if (!camera) return [];
        const severe = severities[id] === "critical" || severities[id] === "high";
        return [{ id, state, calibrated: camera.calibration.length >= 4, severe, pose: camera.pose }];
      }),
    [devices, pushed, severities],
  );
}
export type TagIcon = "offline" | "uncalibrated" | "physical" | "cyber" | "pending" | "contained" | "notified";

export interface Look {
  /** 模型填充色；null 为不填充，只画轮廓 */
  fill: string | null;
  /** 模型不透明度 */
  opacity: number;
  /** 模型轮廓 */
  outline: { color: string; dashed: boolean } | null;
  /** 地面轮廓环（both：网络攻击 + 物理告警） */
  ring: string | null;
  /** 视场：null 为隐藏；breathe 为呼吸动效，另须告警等级为 critical / high（Camera.severe） */
  cone: { color: string; opacity: number; breathe: boolean } | null;
  /** 状态标签：状态色永不单独承载信息，每处同时配图标与文字（V-S3） */
  tags: { icon: TagIcon; text: string; color: string }[];
}

const CONE = { color: STATUS.neutral, opacity: 0.12, breathe: false };
const CYBER_CONE = { color: STATUS.cyber, opacity: 0.25, breathe: true };
/** 处置中、待联动：保持告警色，攻击已在处理，不再呼吸 */
const HELD_CONE = { ...CYBER_CONE, breathe: false };
const base = { opacity: 1, outline: null, ring: null, cone: CONE, tags: [] };

/**
 * §5.2 设备状态机：设备外观的唯一来源。
 * 处置只由 Playbook 触发，M0 中触发处置的规则均含网络攻击（HYD-PLAN-007 §5），
 * 因此"处置中""已通知 · 待联动"保持的告警色为网络攻击色。
 */
export function deviceLook(state: DeviceState): Look {
  switch (state) {
    case "normal":
      return { ...base, fill: STATUS.neutral };
    case "offline":
      return {
        ...base,
        fill: STATUS.uncertain,
        opacity: 0.5,
        cone: null,
        tags: [{ icon: "offline", text: "离线", color: STATUS.uncertain }],
      };
    case "uncalibrated":
      return {
        ...base,
        fill: STATUS.neutral,
        outline: { color: STATUS.uncertain, dashed: true },
        cone: null,
        tags: [{ icon: "uncalibrated", text: "未标定", color: STATUS.uncertain }],
      };
    case "physical_alert":
      return {
        ...base,
        fill: STATUS.physical,
        cone: { color: STATUS.physical, opacity: 0.25, breathe: false },
        tags: [{ icon: "physical", text: "物理告警", color: STATUS.physical }],
      };
    case "cyber_alert":
      return { ...base, fill: STATUS.cyber, cone: CYBER_CONE, tags: [{ icon: "cyber", text: "网络攻击", color: STATUS.cyber }] };
    case "both":
      return {
        ...base,
        fill: STATUS.cyber,
        ring: STATUS.physical,
        cone: CYBER_CONE,
        tags: [
          { icon: "cyber", text: "网络攻击", color: STATUS.cyber },
          { icon: "physical", text: "物理告警", color: STATUS.physical },
        ],
      };
    case "pending_action":
      return {
        ...base,
        fill: null,
        outline: { color: STATUS.contained, dashed: true },
        cone: HELD_CONE,
        tags: [{ icon: "pending", text: "处置中", color: STATUS.contained }],
      };
    case "contained":
      return { ...base, fill: STATUS.contained, tags: [{ icon: "contained", text: "已处置", color: STATUS.contained }] };
    case "notify_only":
      // 旁路模式只能通知，禁止显示"已阻断"（V-T1）
      return {
        ...base,
        fill: STATUS.cyber,
        cone: HELD_CONE,
        tags: [{ icon: "notified", text: "已通知 · 待联动", color: STATUS.cyber }],
      };
  }
}
