import { Bell } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { Site } from "../../lib/api";
import { cn } from "../../lib/utils";
import { areaAlerts, currentArea, showArea, useArea } from "../../scene/areas";
import { SceneViewport, supportsWebGL2 } from "../../scene/SceneViewport";
import { useLive } from "../../store/live";
import { useSelection } from "../../store/selection";
import { groupAlerts } from "../AlertList/AlertList";
import { StaleNotice } from "../ConnectionStatus/ConnectionStatus";
import { Inspector, useInspected } from "../Inspector/Inspector";
import { ProgressBar, progressIncident } from "../IncidentTimeline/ProgressBar";
import { KpiRow } from "../KpiTile/KpiRow";
import { AreaSwitcher } from "./AreaSwitcher";

/**
 * 态势页（设计 150 §3、D-122）：3D 场景铺满，指标、区域切换、告警与详情为浮在其上的白色卡片，彼此不重叠，视口中央留给场景。
 * 卡片外的区域不拦截指针，点选与拖拽落到场景上。告警卡随内容增高、超出时在卡内滚动（V-L2），可收起为带计数的胶囊；
 * 选中设备或目标时总是显示详情卡；底部为处置进度条，详情中不再重复竖向时间线。断线时场景饱和度降至 50%，底部居中提示（V-U3）；
 * 不支持 WebGL2 时同样在底部说明已降级为 2D 视图（C-FE-08）
 */
export function Overview(props: { site: Site; stale: boolean; lastFrameAt: number | null; onBuild?: () => void }) {
  const { site, stale, lastFrameAt, onBuild } = props;
  const area = useCurrentArea(site);
  const [collapsed, setCollapsed] = useState(false);
  const { selected, target } = useInspected(site.devices);
  const capsule = collapsed && !selected && !target;
  const progress = useLive((s) => progressIncident(s.incidents, selected?.id ?? null, area.devices));
  const [webgl2] = useState(supportsWebGL2);
  return (
    <div className="relative min-h-0 flex-1 overflow-hidden">
      <div role="region" aria-label="场景" className={cn("absolute inset-0", stale && "saturate-50")}>
        <SceneViewport site={site} scene={area.current} onBuild={onBuild} />
      </div>
      {/* 止于告警卡左侧 12 px：区域名称过长时截断，不压到告警卡（1366 宽下最紧） */}
      <div className="pointer-events-none absolute top-4 right-[368px] left-4 flex items-start gap-3 min-[1600px]:right-[408px]">
        <KpiRow stale={stale} cards />
        {area.current && <AreaSwitcher areas={site.areas} current={area.current} alerts={area.alerts} />}
      </div>
      <div className="pointer-events-none absolute top-4 right-4 bottom-4 flex w-[340px] flex-col items-end min-[1600px]:w-[380px]">
        {/* 收起时只隐藏不卸载：展开后筛选、展开与滚动位置不丢失 */}
        <aside
          aria-label="告警与详情"
          hidden={capsule}
          className="floating-card pointer-events-auto flex min-h-0 w-full flex-col overflow-hidden"
        >
          <Inspector
            devices={site.devices}
            stale={stale}
            lastFrameAt={lastFrameAt}
            onCollapse={() => setCollapsed(true)}
            timeline={false}
          />
        </aside>
        {capsule && <AlertCapsule onExpand={() => setCollapsed(false)} />}
      </div>
      {/* 底部：断线提示（V-U3）、2D 降级说明与处置进度条，止于视角控件左侧 */}
      <div className="pointer-events-none absolute right-[424px] bottom-4 left-4 flex flex-col items-center gap-2 min-[1600px]:right-[464px]">
        {stale && <StaleNotice lastFrameAt={lastFrameAt} className="" />}
        {!webgl2 && (
          <p
            title="浏览器不支持 WebGL2，已降级为 2D 俯视视图（C-FE-08）"
            className="floating-card pointer-events-auto px-3 py-2 text-meta text-muted-foreground"
          >
            2D 视图 · 不支持 WebGL2
          </p>
        )}
        {progress && <ProgressBar incident={progress} />}
      </div>
    </div>
  );
}

/**
 * 当前区域与各区域的告警（D-124）。首次进入取列表第一个（有告警的优先）并固定下来，之后新告警不自动切换；
 * 选中另一区域的摄像头（如点选告警）时切到该区域
 */
function useCurrentArea(site: Site) {
  const pushed = useLive((s) => s.devices);
  const devices = useMemo(() => site.devices.map((d) => pushed[d.id] ?? d), [site.devices, pushed]);
  const alerts = useMemo(() => areaAlerts(devices), [devices]);
  const areaId = useArea((s) => s.areaId);
  const current = currentArea(site.areas, alerts, areaId);
  useEffect(() => {
    if (current && current.id !== areaId) showArea(current.id);
  }, [current, areaId]);
  const selectedId = useSelection((s) => s.deviceId);
  const selectedArea = devices.find((d) => d.id === selectedId)?.camera?.area_id;
  useEffect(() => {
    if (selectedArea) showArea(selectedArea);
  }, [selectedId, selectedArea]);
  return { current, alerts, devices };
}

/** 收起后的告警胶囊：显示条数（与告警卡标题的计数一致），单击展开 */
function AlertCapsule({ onExpand }: { onExpand: () => void }) {
  const alerts = useLive((s) => s.alerts);
  const incidents = useLive((s) => s.incidents.length);
  const count = useMemo(() => groupAlerts(alerts).length, [alerts]) + incidents;
  return (
    <button
      type="button"
      aria-label={`展开告警（${count} 条）`}
      onClick={onExpand}
      className="floating-card pointer-events-auto flex h-11 items-center gap-2 px-4 text-sm font-medium transition-colors hover:bg-secondary"
    >
      <Bell aria-hidden className="size-4 text-muted-foreground" />
      告警
      <span className="text-meta text-subtle-foreground tabular-nums">{count}</span>
    </button>
  );
}
