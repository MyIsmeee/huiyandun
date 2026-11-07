import { Maximize, Minimize } from "lucide-react";
import { type ReactNode, type RefObject, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { KpiRow } from "../KpiTile/KpiRow";

/**
 * 主画布工具条（HYD-UIX-004 §4.1 C 区、D-115）：左侧为视图相关控件，右侧为关键指标与全屏。
 * 全屏只作用于主画布（监控室投屏，V-W4）。
 */
export function CanvasToolbar(props: { canvas: RefObject<HTMLElement | null>; stale: boolean; children?: ReactNode }) {
  const { canvas, stale, children } = props;
  const full = useFullscreen(canvas);
  return (
    <div className="@container flex h-11 shrink-0 items-center gap-2 border-b bg-card px-2">
      {children}
      <div className="ml-auto flex items-center gap-1">
        <KpiRow stale={stale} />
        <Button
          variant="ghost"
          size="icon"
          aria-label={full.on ? "退出全屏" : "全屏"}
          title={full.on ? "退出全屏" : "全屏"}
          onClick={full.toggle}
          className="size-8 text-muted-foreground"
        >
          {full.on ? <Minimize aria-hidden /> : <Maximize aria-hidden />}
        </Button>
      </div>
    </div>
  );
}

function useFullscreen(target: RefObject<HTMLElement | null>) {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const sync = () => setOn(document.fullscreenElement !== null && document.fullscreenElement === target.current);
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, [target]);
  const toggle = () => {
    // 浏览器拒绝（如未经用户手势、iframe 无权限）时保持原状，按钮状态以 fullscreenchange 为准
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    else void target.current?.requestFullscreen().catch(() => undefined);
  };
  return { on, toggle };
}
