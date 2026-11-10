import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { setLayout, setPage, useWall } from "../../store/wall";
import { pageCount, type WallLayout, wallGrid } from "./grid";

const LAYOUTS: [WallLayout, string][] = [
  ["auto", "自动"],
  ["1", "1"],
  ["4", "4"],
  ["9", "9"],
  ["1+5", "1+5"],
];

/** 监控墙工具条左侧（ui.md §4）：宫格布局与分页（V-W1） */
export function WallControls({ cameras }: { cameras: number }) {
  const { layout, page, zoomed } = useWall();
  const pages = pageCount(cameras, wallGrid(cameras, layout));
  const current = Math.min(page, pages - 1);
  return (
    <>
      <ToggleGroup type="single" size="sm" aria-label="宫格" value={layout} onValueChange={(v) => v && setLayout(v as WallLayout)}>
        {LAYOUTS.map(([value, label]) => (
          <ToggleGroupItem key={value} value={value} aria-label={value === "auto" ? "自动宫格" : `${label} 宫格`} className="min-w-8 px-2 text-meta tabular-nums">
            {label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      {pages > 1 && !zoomed && (
        <span className="flex items-center gap-0.5 text-meta text-muted-foreground tabular-nums">
          <Button variant="ghost" size="icon" aria-label="上一页" disabled={current === 0} onClick={() => setPage(current - 1)} className="size-7">
            <ChevronLeft aria-hidden />
          </Button>
          {current + 1} / {pages}
          <Button variant="ghost" size="icon" aria-label="下一页" disabled={current === pages - 1} onClick={() => setPage(current + 1)} className="size-7">
            <ChevronRight aria-hidden />
          </Button>
        </span>
      )}
    </>
  );
}
