import { Clock } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export type KpiData =
  | { status: "loading" }
  /** delta：较比较基准（默认 1 小时前）的变化量，null 表示无可比数据 */
  | { status: "ready" | "stale"; value: number | null; delta: number | null };

const plain = (value: number) => String(value);

function trend(delta: number, format: (value: number) => string): string {
  if (delta === 0) return "持平";
  return `${delta > 0 ? "↑" : "↓"} ${format(Math.abs(delta))}`;
}

/**
 * 工具条指标中的一项（HYD-UIX-004 §4.1 C 区、D-115）：标签、数值 + 单位、趋势排成一行，不放图表；
 * 无数据显示 —，不显示 0。陈旧数据按 §3.2"不确定 / 非实时"呈现：弱化并配图标与文字（V-S3）。
 */
export function KpiTile(props: {
  label: string;
  unit: string;
  data: KpiData;
  /** 比较基准的说法，默认"较 1 小时前"；只在悬停提示中出现 */
  since?: string;
  /** 数值与变化量的显示格式，默认原样 */
  format?: (value: number) => string;
}) {
  const { label, unit, data, since = "较 1 小时前", format = plain } = props;
  const stale = data.status === "stale";
  const delta = data.status !== "loading" && data.value !== null ? data.delta : null;
  return (
    <div className="flex h-8 items-baseline gap-1.5 px-3 pt-1.5 whitespace-nowrap">
      <span className="text-meta text-muted-foreground">{label}</span>
      {data.status === "loading" ? (
        <Skeleton aria-label="加载中" className="h-4 w-8 self-center" />
      ) : (
        <span className={cn("text-base font-semibold tabular-nums", stale && "text-subtle-foreground")}>
          {data.value === null ? "—" : format(data.value)}
          {data.value !== null && <span className="ml-0.5 text-xs font-normal text-subtle-foreground">{unit}</span>}
        </span>
      )}
      {delta !== null && (
        <span title={since} className="hidden text-xs text-subtle-foreground tabular-nums @5xl:inline">
          {trend(delta, format)}
        </span>
      )}
      {stale && (
        <span className="flex items-center gap-1 self-center text-xs text-uncertain">
          <Clock aria-hidden className="size-3.5" />
          非实时
        </span>
      )}
    </div>
  );
}
