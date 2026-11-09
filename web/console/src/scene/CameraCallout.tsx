import { LayoutGrid } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Thumbnail } from "../panels/CameraRail/CameraRail";
import { useSelection } from "../store/selection";
import { go } from "../store/nav";
import { toggleZoom, useWall } from "../store/wall";
import { useCamera } from "./camera";
import type { Camera } from "./devices";
import type { View } from "./layout";
import { ACCENT } from "./targets";

/** 引线卡的宽度，单位像素 */
const CARD_W = 240;
/** 画面每 2 s 刷新一次（04 V-I6） */
const REFRESH_MS = 2_000;

/**
 * 画面引线卡（04 V-I6，借鉴 Dilum Sanjaya 的 Global Geospatial 地点引线）：空间态势中选中摄像头时，
 * 从机头拉一根折线引线到画面小卡，把 3D 中的位置与它拍到的画面连起来；取消选中即消失。
 * 小卡在指标卡下方、紧靠右侧告警与详情卡的左边，不与其他浮动卡片重叠（设计 150 §3）。
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
    // 卡片宽度固定、贴右侧卡片：窗口变宽变窄时卡片移动而尺寸不变，须同时观察场景
    if (el.parentElement) observer.observe(el.parentElement);
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
          <polyline points={elbow} fill="none" stroke={ACCENT} strokeWidth={1} />
          <circle cx={head?.[0]} cy={head?.[1]} r={3} fill={ACCENT} />
        </svg>
      )}
      <div
        ref={box}
        role="group"
        aria-label={`${camera.id} 画面`}
        style={{ width: CARD_W }}
        className="floating-card absolute top-36 right-[372px] flex flex-col gap-2 p-2 min-[1600px]:right-[412px]"
      >
        <Thumbnail id={camera.id} offline={camera.state === "offline"} refreshMs={REFRESH_MS} />
        <div className="flex items-center gap-2 px-1">
          <span className="flex min-w-0 items-baseline gap-1 text-xs">
            <span className="font-mono">{camera.id}</span>
            <span className="truncate text-muted-foreground">· {camera.name}</span>
          </span>
          {/* 只放图标：给"编号 · 名称"留出宽度，说明见悬停提示 */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label="在监控墙中查看"
                className="ml-auto size-7 shrink-0 text-muted-foreground"
                onClick={() => {
                  go("wall");
                  if (useWall.getState().zoomed !== camera.id) toggleZoom(camera.id);
                }}
              >
                <LayoutGrid aria-hidden />
              </Button>
            </TooltipTrigger>
            <TooltipContent>在监控墙中查看</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </>
  );
}
