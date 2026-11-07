import { Car, User, WifiOff } from "lucide-react";
import { type CSSProperties, type ReactNode, type Ref, useCallback, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { cn } from "@/lib/utils";
import { BEHAVIOR, ICONS } from "../../scene/DeviceTags";
import { deviceLook } from "../../scene/devices";
import { type Device, useLive } from "../../store/live";
import { DetectionOverlay } from "../DetectionOverlay/DetectionOverlay";
import { LiveVideoView, useLiveVideo, type VideoStatus } from "../LiveVideo/LiveVideo";

/** 呈现所需的设备字段；与连接逻辑分开，供组件展示页截图（V-G3） */
export interface TileProps {
  device: Pick<Device, "id" | "name" | "state">;
  selected: boolean;
  /** 告警时的行为（物理告警药丸显示"跌倒 / 攀爬"） */
  behavior?: string;
  persons: number;
  vehicles: number;
  /** 未映射（缺安装参数）：没有跟踪数据，不叠加（V-W5） */
  unmapped: boolean;
  onSelect: () => void;
  onZoom: () => void;
  style?: CSSProperties;
  /** 画面叠加（检测框与骨骼，TK-113）：盖在画面之上、文字标注之下 */
  overlay?: ReactNode;
}

/** 监控墙中的一路（V-W2～V-W4）：连接实时画面，只在当前页渲染（V-W3） */
export function VideoTile(props: Omit<TileProps, "persons" | "vehicles" | "behavior">) {
  const [status, retry] = useLiveVideo(props.device.id);
  const [persons, vehicles] = useLive(
    useShallow((s) => {
      const mine = Object.values(s.targets).filter((t) => t.camera_id === props.device.id);
      const people = mine.filter((t) => t.object_class === "person").length;
      return [people, mine.length - people];
    }),
  );
  const behavior = useLive((s) => s.behaviors[props.device.id]?.behavior);
  const root = useRef<HTMLDivElement>(null);
  const video = useCallback(() => root.current?.querySelector("video") ?? null, []);
  return (
    <VideoTileView
      {...props}
      rootRef={root}
      overlay={!props.unmapped && <DetectionOverlay cameraId={props.device.id} video={video} />}
      status={status}
      onRetry={retry}
      behavior={behavior && BEHAVIOR[behavior]}
      persons={persons}
      vehicles={vehicles}
    />
  );
}

export function VideoTileView(props: TileProps & { status: VideoStatus; onRetry?: () => void; rootRef?: Ref<HTMLDivElement> }) {
  const { device, selected, behavior, persons, vehicles, unmapped, onSelect, onZoom, style, status, onRetry, overlay, rootRef } = props;
  const look = deviceLook(device.state);
  const offline = device.state === "offline";
  // 告警与处置状态：状态色内描边 + 药丸（V-W2）；离线、未标定不算告警，用文字表达
  const alert = look.tags.find((t) => t.icon !== "offline" && t.icon !== "uncalibrated");
  const ring = selected ? "var(--foreground)" : alert?.color;
  return (
    <div
      ref={rootRef}
      role="button"
      tabIndex={0}
      aria-label={`${device.id} ${device.name}`}
      aria-pressed={selected}
      data-tile={device.id}
      onClick={onSelect}
      onDoubleClick={onZoom}
      onKeyDown={(e) => e.key === "Enter" && onSelect()}
      style={style}
      className="group relative cursor-pointer overflow-hidden rounded-lg bg-black outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <LiveVideoView status={status} onRetry={onRetry} className={cn("size-full rounded-none border-0 bg-black", offline && "grayscale")} />
      {status.kind === "playing" && overlay}
      {/* 底部渐隐遮罩保证白字对比度（V-W2） */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-black/70 to-transparent" />
      <p className="pointer-events-none absolute bottom-2 left-3 flex items-baseline gap-2 text-meta text-white">
        <span className="font-mono">{device.id}</span>
        <span className="truncate">{device.name}</span>
      </p>
      <p className="pointer-events-none absolute right-3 bottom-2 flex items-center gap-2 text-xs text-white tabular-nums">
        {unmapped && <span className="text-white/70">未映射</span>}
        {persons > 0 && (
          <span className="flex items-center gap-0.5" aria-label={`人员 ${persons}`}>
            <User aria-hidden className="size-3.5" />
            {persons}
          </span>
        )}
        {vehicles > 0 && (
          <span className="flex items-center gap-0.5" aria-label={`车辆 ${vehicles}`}>
            <Car aria-hidden className="size-3.5" />
            {vehicles}
          </span>
        )}
      </p>
      {alert && <StatePill icon={alert.icon} color={alert.color} text={alert.icon === "physical" && behavior ? `${alert.text} · ${behavior}` : alert.text} />}
      {offline && (
        <p className="pointer-events-none absolute top-2 left-2 flex items-center gap-1.5 rounded-full bg-black/70 px-2.5 py-1 text-xs text-white">
          <WifiOff aria-hidden className="size-3.5" />
          离线
        </p>
      )}
      {/* 描边不呼吸：画面本身在动（V-W2）；选中为白色，优先于告警色 */}
      {ring && <div className="pointer-events-none absolute inset-0 rounded-lg border-2" style={{ borderColor: ring }} />}
    </div>
  );
}

function StatePill({ icon, color, text }: { icon: keyof typeof ICONS; color: string; text: string }) {
  const Icon = ICONS[icon];
  return (
    <p
      role="status"
      style={{ borderColor: color }}
      className="pointer-events-none absolute top-2 left-2 flex items-center gap-1.5 rounded-full border bg-black/75 px-2.5 py-1 text-xs whitespace-nowrap text-white"
    >
      <Icon aria-hidden className="size-3.5" style={{ color }} />
      {text}
    </p>
  );
}
