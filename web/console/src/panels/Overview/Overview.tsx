import type { Site } from "../../lib/api";
import { cn } from "../../lib/utils";
import { SceneViewport } from "../../scene/SceneViewport";
import { StaleNotice } from "../ConnectionStatus/ConnectionStatus";
import { Inspector } from "../Inspector/Inspector";
import { KpiRow } from "../KpiTile/KpiRow";

/**
 * 态势页（设计 150 §3、D-122）：3D 场景铺满，指标、告警与详情为浮在其上的白色卡片，彼此不重叠，视口中央留给场景。
 * 卡片外的区域不拦截指针，点选与拖拽落到场景上。告警卡随内容增高、超出时在卡内滚动（V-L2）。
 * 断线时场景饱和度降至 50%，底部居中提示（V-U3）
 */
export function Overview(props: { site: Site; stale: boolean; lastFrameAt: number | null; onBuild?: () => void }) {
  const { site, stale, lastFrameAt, onBuild } = props;
  return (
    <div className="relative min-h-0 flex-1 overflow-hidden">
      <div role="region" aria-label="场景" className={cn("absolute inset-0", stale && "saturate-50")}>
        <SceneViewport site={site} onBuild={onBuild} />
        {stale && <StaleNotice lastFrameAt={lastFrameAt} />}
      </div>
      <div className="absolute top-4 left-4">
        <KpiRow stale={stale} cards />
      </div>
      <div className="pointer-events-none absolute top-4 right-4 bottom-4 flex w-[340px] flex-col min-[1600px]:w-[380px]">
        <aside aria-label="告警与详情" className="floating-card pointer-events-auto flex min-h-0 flex-col overflow-hidden">
          <Inspector devices={site.devices} stale={stale} lastFrameAt={lastFrameAt} />
        </aside>
      </div>
    </div>
  );
}
