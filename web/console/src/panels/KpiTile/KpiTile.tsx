import { Clock } from "lucide-react";

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
    <div
      className={`min-w-36 rounded-xl border px-4 py-3 ${stale ? "border-dashed border-uncertain" : "border-transparent"}`}
    >
      <p className="flex items-center gap-2 text-sm text-fg-2">
        {label}
        {stale && (
          <span className="flex items-center gap-1 text-uncertain">
            <Clock aria-hidden className="size-3.5" />
            非实时
          </span>
        )}
      </p>
      {data.status === "loading" ? (
        <span aria-label="加载中" className="mt-2 block h-7 w-16 rounded-md bg-raised" />
      ) : (
        <>
          <p className={`mt-1 text-2xl font-black ${stale ? "opacity-50" : ""}`}>
            {data.value === null ? "—" : format(data.value)}
            {data.value !== null && <span className="ml-1 text-sm font-normal text-fg-3">{unit}</span>}
          </p>
          {data.value !== null && data.delta !== null && (
            <p className="mt-1 text-sm text-fg-3">{trend(data.delta, since, format)}</p>
          )}
        </>
      )}
    </div>
  );
}
