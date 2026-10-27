/** 数值 + 单位，不放图表；无数据显示 —，不显示 0（HYD-UIX-004 §4.1 B 区） */
export function KpiTile({ label, value, unit }: { label: string; value: number | null; unit: string }) {
  return (
    <div className="min-w-36 rounded-xl border border-line bg-panel/80 px-4 py-3 backdrop-blur">
      <p className="text-sm text-fg-2">{label}</p>
      <p className="mt-1 text-2xl font-black">
        {value ?? "—"}
        {value !== null && <span className="ml-1 text-sm font-normal text-fg-3">{unit}</span>}
      </p>
    </div>
  );
}
