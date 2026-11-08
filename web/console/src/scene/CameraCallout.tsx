import { LayoutGrid } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Thumbnail } from "../panels/CameraRail/CameraRail";
import { useSelection } from "../store/selection";
import { setView, toggleZoom, useWall } from "../store/wall";
import { useCamera } from "./camera";
import type { Camera } from "./devices";
import type { View } from "./layout";

/** 引线卡的宽度与距场景右上角的边距，单位像素 */
const CARD_W = 240;
const MARGIN = 16;
/** 画面每 2 s 刷新一次（04 V-I6） */
const REFRESH_MS = 2_000;

/**
 * 画面引线卡（04 V-I6，借鉴 Dilum Sanjaya 的 Global Geospatial 地点引线）：空间态势中选中摄像头时，
 * 从机头拉一根折线引线到场景右上的画面小卡，把 3D 中的位置与它拍到的画面连起来；取消选中即消失。
 * 跟随与摄像头视角下不显示（视点即在该摄像头处）。
 */
export function CameraCallout({ cameras, view }: { cameras: Camera[]; view: View }) {
  const selected = useSelection((s) => s.deviceId);
  const focused = useCamera((s) => s.focus !== null);
  const camera = cameras.find((c) => c.id === selected);
  const box = useRef<HTMLDivElement>(null);
  const [card, setCard] = useState<{ x: number; y: number; h: number } | null>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const update = () => setCard({ x: el.offsetLeft, y: el.offsetTop, h: el.offsetHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [camera?.id, focused]);

  if (!camera || focused) return null;
  const head = view.project([camera.pose.x, camera.pose.height_m, camera.pose.y]);
  // 折线：机头 → 水平走到卡片左侧 → 竖直对齐到卡片中部
  const elbow = head && card ? `${head[0]},${head[1]} ${card.x - 24},${head[1]} ${card.x},${card.y + card.h / 2}` : null;
  return (
    <>
      {elbow && (
        <svg aria-hidden className="pointer-events-none absolute inset-0 size-full">
          <polyline points={elbow} fill="none" stroke="rgb(255 255 255 / 0.5)" strokeWidth={1} />
          <circle cx={head?.[0]} cy={head?.[1]} r={3} fill="rgb(255 255 255 / 0.8)" />
        </svg>
      )}
      <div
        ref={box}
        role="group"
        aria-label={`${camera.id} 画面`}
        style={{ width: CARD_W, top: MARGIN, right: MARGIN }}
        className="absolute flex flex-col gap-2 rounded-lg border bg-card p-2 shadow-[0_8px_24px_rgb(0_0_0/0.45)]"
      >
        <Thumbnail id={camera.id} offline={camera.state === "offline"} refreshMs={REFRESH_MS} />
        <div className="flex items-center gap-2 px-1">
          <span className="flex min-w-0 items-baseline gap-1 text-xs">
            <span className="font-mono">{camera.id}</span>
            <span className="truncate text-muted-foreground">· {camera.name}</span>
          </span>
          {/* 只放图标：给"编号 · 名称"留出宽度，说明见悬停提示 */}
          <Button
            variant="ghost"
            size="icon"
            aria-label="在监控墙中查看"
            title="在监控墙中查看"
            className="ml-auto size-7 shrink-0 text-muted-foreground"
            onClick={() => {
              setView("wall");
              if (useWall.getState().zoomed !== camera.id) toggleZoom(camera.id);
            }}
          >
            <LayoutGrid aria-hidden />
          </Button>
        </div>
      </div>
    </>
  );
}
