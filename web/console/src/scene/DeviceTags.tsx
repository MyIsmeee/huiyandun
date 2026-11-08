import { BellRing, Crosshair, LoaderCircle, Lock, type LucideIcon, ShieldAlert, TriangleAlert, WifiOff } from "lucide-react";
import { StatusIcon, StatusPill, statusTint } from "@/components/StatusPill";
import { type Behavior, useLive } from "../store/live";
import { useViewpointCamera } from "./camera";
import { type Camera, deviceLook, type TagIcon } from "./devices";
import type { View } from "./layout";

export const ICONS: Record<TagIcon, LucideIcon> = {
  offline: WifiOff,
  uncalibrated: Crosshair,
  physical: TriangleAlert,
  cyber: ShieldAlert,
  pending: LoaderCircle,
  contained: Lock,
  notified: BellRing,
};
export const BEHAVIOR: Record<Behavior["behavior"], string> = { fall: "跌倒", climb: "攀爬" };
/** 标签底边距机头的高度，单位米 */
const ABOVE_M = 0.5;

/** 告警与处置状态以定位针呈现；离线、未标定不是告警，仍为中性小标签 */
const PLAIN = new Set<TagIcon>(["offline", "uncalibrated"]);

/**
 * 设备状态标注（§5.2 附加列、V-U4）：告警与处置时机身上方一枚定位针（状态色 + 图标，屏幕尺寸固定），
 * 针头上方一行状态文字（物理告警附行为与发生时刻），借鉴 Dilum Sanjaya 的 WareTrack 定位针；取代原场景内事件卡。
 * 状态色只用于图标与边框，文字为主要文字色（V-S3）。场景内标注随设备定位，不计入浮层（V-L3）。
 */
export function DeviceTags({ cameras, view }: { cameras: Camera[]; view: View }) {
  const behaviors = useLive((s) => s.behaviors);
  const viewing = useViewpointCamera(); // 视点一侧的摄像头模型不画，标签随之不画，免得悬空
  return cameras.map(({ id, state, pose }) => {
    const { tags } = deviceLook(state);
    if (tags.length === 0 || id === viewing) return null;
    const at = view.project([pose.x, pose.height_m + ABOVE_M, pose.y]);
    if (!at) return null;
    const [left, top] = at;
    const alerts = tags.filter((t) => !PLAIN.has(t.icon));
    const behavior = behaviors[id];
    const detail =
      behavior && alerts.some((t) => t.icon === "physical")
        ? [BEHAVIOR[behavior.behavior], new Date(behavior.ts_start).toLocaleTimeString("zh-CN", { hour12: false })]
        : [];
    return (
      <div
        key={id}
        data-device={id}
        style={{ left, top }}
        className="pointer-events-none absolute flex -translate-x-1/2 -translate-y-full flex-col items-center"
      >
        {tags
          .filter((t) => PLAIN.has(t.icon))
          .map(({ icon, text, color }) => (
            <StatusPill key={icon} icon={ICONS[icon]} color={color} className="mb-1">
              {text}
            </StatusPill>
          ))}
        {alerts.length > 0 && <Pin tags={alerts} detail={detail} />}
      </div>
    );
  });
}

/** 定位针：状态文字 → 针头（首个状态的图标与颜色，同时命中两类时外圈为第二个状态色）→ 指向机身的针杆 */
function Pin({ tags, detail }: { tags: ReturnType<typeof deviceLook>["tags"]; detail: string[] }) {
  const [first, second] = tags;
  if (!first) return null;
  return (
    <>
      <span
        role="status"
        style={{ borderColor: first.color, backgroundColor: statusTint(first.color) }}
        className="mb-1 rounded-full border px-2.5 py-0.5 text-xs whitespace-nowrap text-foreground tabular-nums"
      >
        {[...tags.map((t) => t.text), ...detail].join(" · ")}
      </span>
      <span
        style={{ borderColor: first.color, boxShadow: second ? `0 0 0 2px ${second.color}` : undefined }}
        className="grid size-7 place-items-center rounded-full border-2 bg-card"
      >
        <StatusIcon icon={ICONS[first.icon]} color={first.color} />
      </span>
      <span aria-hidden className="h-3 w-0.5" style={{ backgroundColor: first.color }} />
    </>
  );
}
