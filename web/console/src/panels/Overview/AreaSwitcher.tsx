import { ChevronDown, MapPinned, ShieldAlert, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { type Area, type AreaAlerts, showArea, sortAreas } from "../../scene/areas";

/**
 * 区域切换（设计 150 §3、D-124）：下拉列出全部区域，有告警的置顶，各区域旁为告警中的设备数（图标 + 数字，V-S3）；
 * 按钮上另标出其他区域的告警，提示切过去查看
 */
export function AreaSwitcher(props: { areas: Area[]; current: Area; alerts: Map<string, AreaAlerts> }) {
  const { areas, current, alerts } = props;
  const others = [...alerts].filter(([id]) => id !== current.id).map(([, counts]) => counts);
  const elsewhere = { physical: sum(others, "physical"), cyber: sum(others, "cyber") };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" aria-label={`区域：${current.name}`} className="floating-card pointer-events-auto h-11 min-w-0 shrink gap-2 px-4 hover:bg-secondary">
          <MapPinned aria-hidden className="text-muted-foreground" />
          <span className="max-w-32 min-w-0 truncate font-medium">{current.name}</span>
          {/* 1366 宽下与指标卡同处一行，不写文字说明，悬停提示"其他区域" */}
          {(elsewhere.physical > 0 || elsewhere.cyber > 0) && (
            <span role="group" aria-label="其他区域" title="其他区域" className="border-l pl-2">
              <AlertCounts counts={elsewhere} />
            </span>
          )}
          <ChevronDown aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-56">
        <DropdownMenuRadioGroup value={current.id} onValueChange={showArea}>
          {sortAreas(areas, alerts).map((area) => {
            const counts = alerts.get(area.id);
            return (
              <DropdownMenuRadioItem key={area.id} value={area.id}>
                <span className="truncate">{area.name}</span>
                {counts && (
                  <span className="ml-auto pl-3">
                    <AlertCounts counts={counts} />
                  </span>
                )}
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const sum = (list: AreaAlerts[], key: keyof AreaAlerts) => list.reduce((total, counts) => total + counts[key], 0);

/** 告警中的设备数：物理告警与网络攻击各一个图标 + 数字，为 0 的不显示；状态色只用于图标（ui.md §3） */
function AlertCounts({ counts }: { counts: AreaAlerts }) {
  return (
    <span className="flex items-center gap-2 text-meta text-foreground tabular-nums">
      {counts.physical > 0 && (
        <span role="img" className="flex items-center gap-0.5" aria-label={`物理告警 ${counts.physical} 台`}>
          <TriangleAlert aria-hidden className="size-4 fill-physical text-foreground" />
          {counts.physical}
        </span>
      )}
      {counts.cyber > 0 && (
        <span role="img" className="flex items-center gap-0.5" aria-label={`网络攻击 ${counts.cyber} 台`}>
          <ShieldAlert aria-hidden className="size-4 text-cyber" />
          {counts.cyber}
        </span>
      )}
    </span>
  );
}
