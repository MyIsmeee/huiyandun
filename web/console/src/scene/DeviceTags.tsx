import { BellRing, Crosshair, LoaderCircle, Lock, type LucideIcon, ShieldAlert, TriangleAlert, WifiOff } from "lucide-react";
import { type Camera, deviceLook, type TagIcon } from "./devices";
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
/** 标签底边距机头的高度，单位米 */
const ABOVE_M = 0.5;

/**
 * 设备状态标签（§5.2 附加列）：状态色只用于图标与边框，文字为主要文字色（V-S3）。
 * 场景内标注随设备定位，不计入浮层（V-L3）。
 */
export function DeviceTags({ cameras, view }: { cameras: Camera[]; view: View }) {
  return cameras.map(({ id, state, pose }) => {
    const { tags } = deviceLook(state);
    if (tags.length === 0) return null;
    const [left, top] = view.project([pose.x, pose.height_m + ABOVE_M, pose.y]);
    return (
      <div
        key={id}
        data-device={id}
        style={{ left, top }}
        className="pointer-events-none absolute flex -translate-x-1/2 -translate-y-full flex-col items-center gap-1"
      >
        {tags.map(({ icon, text, color }) => {
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
