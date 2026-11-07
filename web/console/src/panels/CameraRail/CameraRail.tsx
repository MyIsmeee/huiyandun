import { Car, CircleCheck, PanelLeftClose, PanelLeftOpen, Plus, User, VideoOff } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { api } from "../../lib/api";
import { ICONS } from "../../scene/DeviceTags";
import { deviceLook } from "../../scene/devices";
import { type Device, useLive } from "../../store/live";
import { select, useSelection } from "../../store/selection";
import { toggleRail, useWall } from "../../store/wall";
import { CameraEditor } from "../CameraEditor/CameraEditor";

/** 缩略图刷新间隔；失败后退避（设计 140 §9） */
const REFRESH_MS = 10_000;
const BACKOFF_MS = 60_000;

/**
 * B 摄像头栏（HYD-UIX-004 §4.1、D-115）：每台摄像头一张卡片（缩略图、编号与名称、状态、人员与车辆数），
 * 单击选中（监控墙随之翻页、检查栏显示详情）。可收起为图标栏。admin 底部可直接添加摄像头。
 */
export function CameraRail(props: { devices: Device[]; admin: boolean }) {
  const { devices, admin } = props;
  const pushed = useLive((s) => s.devices);
  const cameras = useMemo(() => devices.filter((d) => d.camera).map((d) => pushed[d.id] ?? d), [devices, pushed]);
  const collapsed = useWall((s) => s.railCollapsed);
  const selectedId = useSelection((s) => s.deviceId);
  const [adding, setAdding] = useState(false);
  return (
    <aside aria-label="摄像头栏" className={cn("flex min-h-0 flex-col border-r bg-card", collapsed ? "w-20" : "w-60")}>
      <header className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
        {!collapsed && (
          <>
            <h2 className="text-base font-medium">摄像头</h2>
            <span className="text-meta text-subtle-foreground tabular-nums">{cameras.length}</span>
          </>
        )}
        <Button
          variant="ghost"
          size="icon"
          aria-label={collapsed ? "展开摄像头栏" : "收起摄像头栏"}
          onClick={toggleRail}
          className="ml-auto size-8 text-muted-foreground"
        >
          {collapsed ? <PanelLeftOpen aria-hidden /> : <PanelLeftClose aria-hidden />}
        </Button>
      </header>
      <ul className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
        {cameras.length === 0 && !collapsed && <li className="px-2 py-6 text-center text-meta text-subtle-foreground">尚未登记摄像头</li>}
        {cameras.map((camera) => (
          <li key={camera.id}>
            <RailCard device={camera} collapsed={collapsed} selected={camera.id === selectedId} onSelect={() => select(camera.id)} />
          </li>
        ))}
      </ul>
      {admin && (
        <div className="shrink-0 border-t p-2">
          <Button variant="ghost" size="sm" aria-label="添加摄像头" onClick={() => setAdding(true)} className="w-full text-muted-foreground">
            <Plus aria-hidden />
            {!collapsed && "添加摄像头"}
          </Button>
        </div>
      )}
      {adding && <CameraEditor camera={null} onClose={() => setAdding(false)} onSaved={() => undefined} />}
    </aside>
  );
}

function RailCard(props: { device: Device; collapsed: boolean; selected: boolean; onSelect: () => void }) {
  const { device, collapsed, selected, onSelect } = props;
  const [persons, vehicles] = useLive(
    useShallow((s) => {
      const mine = Object.values(s.targets).filter((t) => t.camera_id === device.id);
      const people = mine.filter((t) => t.object_class === "person").length;
      return [people, mine.length - people];
    }),
  );
  const tag = deviceLook(device.state).tags[0];
  const Icon = tag ? ICONS[tag.icon] : CircleCheck;
  // 告警与处置：状态色描边（V-S3 另配图标与文字）；离线与未标定只用文字
  const alert = tag && tag.icon !== "offline" && tag.icon !== "uncalibrated" ? tag.color : undefined;
  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={`${device.id} ${device.name}`}
      onClick={onSelect}
      style={alert ? { borderColor: alert } : undefined}
      className={cn(
        "flex w-full flex-col gap-1.5 rounded-lg border-2 p-1.5 text-left transition-colors hover:bg-secondary",
        selected ? "border-foreground bg-accent" : !alert && "border-transparent",
      )}
    >
      {!collapsed && <Thumbnail id={device.id} offline={device.state === "offline"} />}
      <span className={cn("flex items-center gap-1.5 px-1", collapsed && "flex-col")}>
        <Icon aria-hidden className="size-3.5 shrink-0" style={{ color: tag?.color }} />
        <span className="font-mono text-xs whitespace-nowrap">{device.id}</span>
        {!collapsed && <span className="truncate text-meta">{device.name}</span>}
      </span>
      {!collapsed && (
        <span className="flex items-center gap-3 px-1 text-xs text-subtle-foreground tabular-nums">
          <span>{tag?.text ?? "在线"}</span>
          {persons > 0 && (
            <span className="flex items-center gap-0.5" aria-label={`人员 ${persons}`}>
              <User aria-hidden className="size-3" />
              {persons}
            </span>
          )}
          {vehicles > 0 && (
            <span className="flex items-center gap-0.5" aria-label={`车辆 ${vehicles}`}>
              <Car aria-hidden className="size-3" />
              {vehicles}
            </span>
          )}
        </span>
      )}
    </button>
  );
}

/** 16:9 缩略图：只在可见且页面未隐藏时按间隔（默认 10 s）取一帧，失败退避到 60 s；离线时去饱和。空间态势的画面引线卡同样使用 */
export function Thumbnail({ id, offline, refreshMs = REFRESH_MS }: { id: string; offline: boolean; refreshMs?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let visible = false;
    let active = true;
    let current: string | null = null;
    async function load() {
      clearTimeout(timer);
      if (!active || !visible || document.hidden) return;
      const blob = await api.getCameraSnapshot(id).catch(() => null);
      if (!active) return;
      if (blob) {
        const next = URL.createObjectURL(blob);
        setUrl(next);
        if (current) URL.revokeObjectURL(current);
        current = next;
      }
      timer = setTimeout(() => void load(), blob ? refreshMs : BACKOFF_MS);
    }
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? false;
      if (visible) void load();
    });
    if (ref.current) observer.observe(ref.current);
    const onVisibility = () => void load();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      active = false;
      clearTimeout(timer);
      observer.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      if (current) URL.revokeObjectURL(current);
    };
  }, [id, refreshMs]);
  return (
    <div ref={ref} className="relative aspect-video overflow-hidden rounded-md bg-black">
      {url ? (
        <img src={url} alt="" className={cn("size-full object-cover", offline && "grayscale")} />
      ) : (
        <span className="absolute inset-0 grid place-items-center text-subtle-foreground">
          <VideoOff aria-hidden className="size-4" />
        </span>
      )}
    </div>
  );
}
