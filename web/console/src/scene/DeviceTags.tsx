import { BellRing, Crosshair, LoaderCircle, Lock, type LucideIcon, ShieldAlert, TriangleAlert, WifiOff } from "lucide-react";
import { type Behavior, useLive } from "../store/live";
import { type Camera, deviceLook, STATUS, type TagIcon } from "./devices";
import type { View } from "./layout";

const ICONS: Record<TagIcon, LucideIcon> = {
  offline: WifiOff,
  uncalibrated: Crosshair,
  physical: TriangleAlert,
  cyber: ShieldAlert,
  pending: LoaderCircle,
  contained: Lock,
  notified: BellRing,
};
const BEHAVIOR: Record<Behavior["behavior"], string> = { fall: "跌倒", climb: "攀爬" };
/** 标签底边距机头的高度，单位米 */
const ABOVE_M = 0.5;

/**
 * 设备状态标签（§5.2 附加列）：状态色只用于图标与边框，文字为主要文字色（V-S3）。
 * 场景内标注随设备定位，不计入浮层（V-L3）。
 */
export function DeviceTags({ cameras, view }: { cameras: Camera[]; view: View }) {
  const behaviors = useLive((s) => s.behaviors);
  return cameras.map(({ id, state, pose }) => {
    const { tags } = deviceLook(state);
    if (tags.length === 0) return null;
    const at = view.project([pose.x, pose.height_m + ABOVE_M, pose.y]);
    if (!at) return null;
    const [left, top] = at;
    return (
      <div
        key={id}
        data-device={id}
        style={{ left, top }}
        className="pointer-events-none absolute flex -translate-x-1/2 -translate-y-full flex-col items-center gap-1"
      >
        {tags.map(({ icon, text, color }) => {
          const behavior = behaviors[id];
          if (icon === "physical" && behavior) return <EventCard key={icon} camera={id} behavior={behavior} />;
          const Icon = ICONS[icon];
          return (
            <span
              key={icon}
              style={{ borderColor: color }}
              className="flex items-center gap-1 rounded-full border bg-panel/90 px-2 py-0.5 text-xs whitespace-nowrap text-fg"
            >
              <Icon aria-hidden className="size-3.5" style={{ color }} />
              {text}
            </span>
          );
        })}
      </div>
    );
  });
}

/** 场景内事件卡（V-U4）：物理告警的行为、设备与发生时刻；设备退出物理告警即随标签消失 */
function EventCard({ camera, behavior }: { camera: string; behavior: Behavior }) {
  const time = new Date(behavior.ts_start).toLocaleTimeString("zh-CN", { hour12: false });
  return (
    <span
      role="status"
      style={{ borderColor: STATUS.physical }}
      className="flex flex-col rounded-xl border bg-panel/90 px-3 py-1.5 whitespace-nowrap text-fg"
    >
      <span className="flex items-center gap-1.5 text-sm">
        <TriangleAlert aria-hidden className="size-4" style={{ color: STATUS.physical }} />
        物理告警 · {BEHAVIOR[behavior.behavior]}
      </span>
      <span className="text-xs text-fg-2 tabular-nums">
        {camera} · {time}
      </span>
    </span>
  );
}
