import { useRef } from "react";
import type { Site } from "../../lib/api";
import { cn } from "../../lib/utils";
import { CameraRail } from "../CameraRail/CameraRail";
import { CanvasToolbar } from "../CanvasToolbar/CanvasToolbar";
import { StaleNotice } from "../ConnectionStatus/ConnectionStatus";
import { Inspector } from "../Inspector/Inspector";
import { VideoWall } from "./VideoWall";
import { WallControls } from "./WallControls";

/**
 * 监控墙页（设计 150 §3、D-122）：摄像头栏 + 监控墙 + 检查栏，分区位置固定（V-L1）。
 * 检查栏未选中时为告警列表，选中设备或目标时换成详情。断线时画面饱和度降至 50%，底部居中提示（V-U3）
 */
export function WallPage(props: { site: Site; admin: boolean; stale: boolean; lastFrameAt: number | null }) {
  const { site, admin, stale, lastFrameAt } = props;
  const canvas = useRef<HTMLElement>(null);
  const cameraCount = site.devices.filter((d) => d.camera).length;
  return (
    <div className="grid min-h-0 flex-1 grid-cols-[auto_minmax(0,1fr)_360px] 2xl:grid-cols-[auto_minmax(0,1fr)_400px]">
      <CameraRail devices={site.devices} admin={admin} />
      <section ref={canvas} aria-label="主画布" className="flex min-h-0 flex-col bg-background">
        <CanvasToolbar canvas={canvas} stale={stale}>
          <WallControls cameras={cameraCount} />
        </CanvasToolbar>
        <div role="region" aria-label="监控墙视图" className={cn("relative min-h-0 flex-1 overflow-hidden", stale && "saturate-50")}>
          <VideoWall devices={site.devices} />
          {stale && <StaleNotice lastFrameAt={lastFrameAt} />}
        </div>
      </section>
      <aside aria-label="检查栏" className="flex min-h-0 flex-col border-l bg-card">
        <Inspector devices={site.devices} stale={stale} lastFrameAt={lastFrameAt} />
      </aside>
    </div>
  );
}
