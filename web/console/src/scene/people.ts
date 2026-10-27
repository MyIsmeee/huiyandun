import type { Behavior, Person } from "../store/live";
import type { Camera } from "./devices";

/** 不确定半径超过此值时化身改为虚线轮廓（V-U1） */
export const HIGH_ERROR_M = 1;

export interface Avatar extends Person {
  key: string;
  /** 跌倒或攀爬中：所属摄像头处于物理告警，且其最近一次行为事件指向此人 */
  alert: boolean;
  uncertain: boolean;
}

/** 场景中的人员化身：只投放已标定、已登记摄像头的人员（V-U2） */
export function avatars(people: Record<string, Person>, cameras: Camera[], behaviors: Record<string, Behavior>): Avatar[] {
  const states = new Map(cameras.map((c) => [c.id, c.state]));
  return Object.entries(people).flatMap(([key, person]) => {
    const state = states.get(person.camera_id);
    if (state === undefined || state === "uncalibrated") return [];
    const physical = state === "physical_alert" || state === "both";
    const alert = physical && behaviors[person.camera_id]?.track_id === person.track_id;
    return [{ ...person, key, alert, uncertain: person.uncertainty_m > HIGH_ERROR_M }];
  });
}
