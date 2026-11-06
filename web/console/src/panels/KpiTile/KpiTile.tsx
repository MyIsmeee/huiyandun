import { Clock } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export type KpiData =
  | { status: "loading" }
  /** delta：较比较基准（默认 1 小时前）的变化量，null 表示无可比数据 */
  | { status: "ready" | "stale"; value: number | null; delta: number | null };

const plain = (value: number) => String(value);

function trend(delta: number, since: string, format: (value: number) => string): string {
  if (delta === 0) return `${since} 持平`;
  return `${since} ${delta > 0 ? "↑" : "↓"} ${format(Math.abs(delta))}`;
}

/**
 * 数值 + 单位 + 趋势，不放图表；无数据显示 —，不显示 0（HYD-UIX-004 §4.1 B 区）。
 * 陈旧数据按 §3.2"不确定 / 非实时"呈现：虚线 + 弱化，并配图标与文字（V-S3）。
 */
export function KpiTile(props: {
  label: string;
  unit: string;
  data: KpiData;
  /** 比较基准的说法，默认"较 1 小时前" */
  since?: string;
  /** 数值与变化量的显示格式，默认原样 */
  format?: (value: number) => string;
}) {
  const { label, unit, data, since = "较 1 小时前", format = plain } = props;
  const stale = data.status === "stale";
  return (
    <div className={cn("min-w-36 rounded-md border px-4 py-3", stale ? "border-dashed border-uncertain" : "border-transparent")}>
      <p className="flex items-center gap-2 text-meta text-muted-foreground">
        {label}
        {stale && (
          <span className="flex items-center gap-1 text-uncertain">
            <Clock aria-hidden className="size-3.5" />
            非实时
          </span>
        )}
      </p>
      {data.status === "loading" ? (
        <Skeleton aria-label="加载中" className="mt-2 h-8 w-16" />
      ) : (
        <>
          <p className={cn("mt-1 text-kpi font-semibold tabular-nums", stale && "opacity-50")}>
            {data.value === null ? "—" : format(data.value)}
            {data.value !== null && <span className="ml-1 text-sm font-normal text-subtle-foreground">{unit}</span>}
          </p>
          {data.value !== null && data.delta !== null && (
            <p className="text-xs text-subtle-foreground tabular-nums">{trend(data.delta, since, format)}</p>
          )}
        </>
      )}
    </div>
  );
}
