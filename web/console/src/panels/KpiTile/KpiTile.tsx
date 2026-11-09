import { Clock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";

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
 * 一项关键指标：监控墙工具条中标签、数值 + 单位、趋势排成一行；态势页为浮动卡片。不放图表；
 * 无数据显示 —，不显示 0。陈旧数据按 §3.2"不确定 / 非实时"呈现：弱化并配图标与文字（V-S3）。
 */
export function KpiTile(props: {
  label: string;
  unit: string;
  data: KpiData;
  /** 比较基准的说法，默认"较 1 小时前"：工具条中只在悬停提示中出现，卡片中为脚注 */
  since?: string;
  /** 数值与变化量的显示格式，默认原样 */
  format?: (value: number) => string;
  /** 态势页的浮动指标卡（设计 150 §9A，借鉴 shadcn dashboard-01 的 section-cards）：小标签 + 趋势徽标、大数字、一行脚注 */
  card?: boolean;
}) {
  const { label, unit, data, since = "较 1 小时前", format = plain, card = false } = props;
  const stale = data.status === "stale";
  const delta = data.status !== "loading" && data.value !== null ? data.delta : null;
  const value =
    data.status === "loading" ? (
      <Skeleton aria-label="加载中" className={card ? "h-9 w-8" : "h-4 w-4 self-center"} />
    ) : (
      // 不经 cn 合并：tailwind-merge 不认识字号令牌 text-kpi，会把它当作文字颜色与 text-subtle-foreground 相互覆盖
      <span className={`font-semibold tabular-nums ${card ? "text-kpi" : "text-base"} ${stale ? "text-subtle-foreground" : ""}`}>
        {data.value === null ? "—" : format(data.value)}
        {data.value !== null && <span className="ml-0.5 text-xs font-normal text-subtle-foreground">{unit}</span>}
      </span>
    );
  const notice = stale && (
    <span className="flex items-center gap-1 self-center text-xs text-muted-foreground">
      <Clock aria-hidden className="size-3.5" />
      非实时
    </span>
  );
  if (card) {
    return (
      <div className="floating-card flex w-41 flex-col gap-0.5 p-3 whitespace-nowrap">
        <span className="flex items-center justify-between gap-1">
          <span className="text-meta text-muted-foreground">{label}</span>
          {delta !== null && (
            <Badge variant="outline" title={since} className="px-1.5 font-normal text-subtle-foreground tabular-nums">
              {trend(delta, format)}
            </Badge>
          )}
        </span>
        {value}
        <span className="flex h-4 items-center text-xs text-subtle-foreground">{notice || (delta !== null && since)}</span>
      </div>
    );
  }
  return (
    <div className="flex h-8 items-baseline gap-1.5 px-2.5 pt-1.5 whitespace-nowrap">
      <span className="text-meta text-muted-foreground">{label}</span>
      {value}
      {delta !== null && (
        <span title={since} className="hidden text-xs text-subtle-foreground tabular-nums @5xl:inline">
          {trend(delta, format)}
        </span>
      )}
      {notice}
    </div>
  );
}
