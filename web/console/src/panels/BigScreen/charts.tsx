import { type ReactNode, type RefObject, useEffect, useId, useRef, useState } from "react";

/**
 * 大屏图表：原项目用 ECharts 画历史功率（平滑面积线）、日发电量（单系列柱）与故障对比（分组柱），
 * 这里改为手写 SVG，不为三张小图引入 ECharts。线 2px、柱顶 3px 圆角贴底、网格虚线弱化；
 * 两个系列总有图例，悬停给出十字线 / 单柱提示；文字用正文色，不用系列色
 */

export interface Series {
  name: string;
  color: string;
  values: number[];
}

const PAD = { left: 34, right: 10, top: 28, bottom: 22 };
const GRID = 4;
const AXIS_TEXT = "rgba(214, 228, 255, 0.72)";
const GRID_LINE = "rgba(200, 200, 200, 0.16)";

function useBox(ref: RefObject<HTMLElement | null>) {
  const [box, setBox] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry)
        setBox({
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return box;
}

/** 纵轴上限取 1、2、2.5、5 × 10ⁿ，分 GRID 格；全为 0 时为 GRID */
export function niceMax(max: number): number {
  if (max <= 0) return GRID;
  const raw = max / GRID;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? raw;
  return Math.max(step * GRID, GRID);
}

/** 单调三次插值（Fritsch–Carlson）：曲线平滑且不越过相邻点，计数不会画到 0 以下 */
export function monotonePath(points: [number, number][]): string {
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  const at = (a: number[], i: number) => a[i] ?? 0;
  const n = points.length;
  if (n === 0) return "";
  if (n === 1) return `M${at(xs, 0)},${at(ys, 0)}`;
  const dx = xs.slice(1).map((x, i) => x - at(xs, i));
  const slope = ys.slice(1).map((y, i) => (y - at(ys, i)) / (at(dx, i) || 1));
  const tangent = xs.map((_, i) => {
    if (i === 0) return at(slope, 0);
    if (i === n - 1) return at(slope, n - 2);
    const [a, b, h0, h1] = [at(slope, i - 1), at(slope, i), at(dx, i - 1), at(dx, i)];
    return a * b <= 0 ? 0 : (3 * (h0 + h1)) / ((2 * h1 + h0) / a + (h1 + 2 * h0) / b);
  });
  let d = `M${at(xs, 0)},${at(ys, 0)}`;
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0, x1, y1, h] = [at(xs, i), at(ys, i), at(xs, i + 1), at(ys, i + 1), at(dx, i) / 3];
    d += `C${x0 + h},${y0 + at(tangent, i) * h} ${x1 - h},${y1 - at(tangent, i + 1) * h} ${x1},${y1}`;
  }
  return d;
}

function Legend({ series }: { series: Series[] }) {
  if (series.length < 2) return null;
  return (
    <div className="bs-legend">
      {series.map((s) => (
        <span key={s.name}>
          <i style={{ background: s.color }} />
          {s.name}
        </span>
      ))}
    </div>
  );
}

function Tip({ x, y, width, children }: { x: number; y: number; width: number; children: ReactNode }) {
  // 靠右时翻到指针左侧，不出面板
  const left = x > width * 0.6;
  return (
    <div
      className="bs-tip"
      style={{
        top: y,
        left: left ? undefined : x + 12,
        right: left ? width - x + 12 : undefined,
      }}
    >
      {children}
    </div>
  );
}

function Axes({ width, height, max, labels, every }: { width: number; height: number; max: number; labels: string[]; every: number }) {
  const plotH = height - PAD.top - PAD.bottom;
  const plotW = width - PAD.left - PAD.right;
  const step = plotW / Math.max(labels.length, 1);
  return (
    <g>
      {Array.from({ length: GRID + 1 }, (_, i) => {
        const y = PAD.top + plotH - (plotH * i) / GRID;
        return (
          <g key={i}>
            <line x1={PAD.left} x2={width - PAD.right} y1={y} y2={y} stroke={GRID_LINE} strokeDasharray="4 4" />
            <text x={PAD.left - 6} y={y} dy="0.32em" textAnchor="end" fill={AXIS_TEXT} fontSize={11}>
              {Math.round((max * i) / GRID)}
            </text>
          </g>
        );
      })}
      {labels.map((label, i) =>
        i % every === 0 ? (
          <text key={i} x={PAD.left + step * i + step / 2} y={height - 6} textAnchor="middle" fill={AXIS_TEXT} fontSize={11}>
            {label}
          </text>
        ) : null,
      )}
    </g>
  );
}

/** 横轴标签的间隔：每个标签约占 44 px */
const labelEvery = (count: number, plotW: number) => Math.max(1, Math.ceil(count / Math.max(1, Math.floor(plotW / 44))));

/** 平滑折线，第一个系列带面积渐变（原"历史功率"） */
export function LineChart({ labels, series, label }: { labels: string[]; series: Series[]; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const { width, height } = useBox(ref);
  const [hover, setHover] = useState<number | null>(null);
  const gradient = useId();
  const plotW = width - PAD.left - PAD.right;
  const plotH = height - PAD.top - PAD.bottom;
  const max = niceMax(Math.max(0, ...series.flatMap((s) => s.values)));
  const step = plotW / Math.max(labels.length, 1);
  const px = (i: number) => PAD.left + step * i + step / 2;
  const py = (v: number) => PAD.top + plotH - (plotH * v) / max;
  return (
    <div ref={ref} className="bs-chart">
      <Legend series={series} />
      {width > 0 && height > 0 && (
        <svg width={width} height={height} role="img" aria-label={label}>
          <defs>
            <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor={series[0]?.color} stopOpacity={0.4} />
              <stop offset="1" stopColor={series[0]?.color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <Axes width={width} height={height} max={max} labels={labels} every={labelEvery(labels.length, plotW)} />
          {series.map((s, k) => {
            const points = s.values.map((v, i) => [px(i), py(v)] as [number, number]);
            const line = monotonePath(points);
            return (
              <g key={s.name}>
                {k === 0 && points.length > 1 && (
                  <path d={`${line}L${px(points.length - 1)},${py(0)}L${px(0)},${py(0)}Z`} fill={`url(#${gradient})`} />
                )}
                <path d={line} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" />
              </g>
            );
          })}
          {hover !== null && (
            <g pointerEvents="none">
              <line x1={px(hover)} x2={px(hover)} y1={PAD.top} y2={PAD.top + plotH} stroke="rgba(255,255,255,0.35)" />
              {series.map((s) => (
                <circle key={s.name} cx={px(hover)} cy={py(s.values[hover] ?? 0)} r={4} fill={s.color} stroke="#071a33" strokeWidth={2} />
              ))}
            </g>
          )}
          <rect
            x={PAD.left}
            y={PAD.top}
            width={Math.max(plotW, 0)}
            height={Math.max(plotH, 0)}
            fill="transparent"
            onMouseMove={(e) => {
              const box = e.currentTarget.getBoundingClientRect();
              const i = Math.floor(((e.clientX - box.left) / box.width) * labels.length);
              setHover(Math.min(labels.length - 1, Math.max(0, i)));
            }}
            onMouseLeave={() => setHover(null)}
          />
        </svg>
      )}
      {hover !== null && (
        <Tip x={px(hover)} y={PAD.top} width={width}>
          <b>{labels[hover]}</b>
          {series.map((s) => (
            <span key={s.name}>
              <i style={{ background: s.color }} />
              {s.name}
              <em>{s.values[hover] ?? 0}</em>
            </span>
          ))}
        </Tip>
      )}
    </div>
  );
}

/** 柱状图：一个系列为单柱（原"日发电量"），两个系列为分组柱（原"故障对比"） */
export function BarChart({ labels, series, label, unit = "" }: { labels: string[]; series: Series[]; label: string; unit?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const { width, height } = useBox(ref);
  const [hover, setHover] = useState<number | null>(null);
  const id = useId();
  const plotW = width - PAD.left - PAD.right;
  const plotH = height - PAD.top - PAD.bottom;
  const max = niceMax(Math.max(0, ...series.flatMap((s) => s.values)));
  const step = plotW / Math.max(labels.length, 1);
  // 柱宽：单系列占格宽 60%，分组时每柱最宽 20 px、柱间留 2 px
  const groupW = Math.min(step * (series.length > 1 ? 0.7 : 0.6), series.length * 20 + (series.length - 1) * 2);
  const barW = (groupW - (series.length - 1) * 2) / series.length;
  const py = (v: number) => PAD.top + plotH - (plotH * v) / max;
  return (
    <div ref={ref} className="bs-chart">
      <Legend series={series} />
      {width > 0 && height > 0 && (
        <svg width={width} height={height} role="img" aria-label={label}>
          <defs>
            {series.map((s, k) => (
              <linearGradient key={s.name} id={`${id}-${k}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor={s.color} stopOpacity={1} />
                <stop offset="1" stopColor={s.color} stopOpacity={0.15} />
              </linearGradient>
            ))}
          </defs>
          <Axes width={width} height={height} max={max} labels={labels} every={labelEvery(labels.length, plotW)} />
          {labels.map((_, i) => {
            const x0 = PAD.left + step * i + (step - groupW) / 2;
            return (
              <g key={i} opacity={hover === null || hover === i ? 1 : 0.55}>
                {series.map((s, k) => {
                  const v = s.values[i] ?? 0;
                  if (v <= 0) return null;
                  const [x, y] = [x0 + k * (barW + 2), py(v)];
                  const h = py(0) - y;
                  const r = Math.min(3, barW / 2, h);
                  return (
                    <path
                      key={s.name}
                      d={`M${x},${py(0)}V${y + r}Q${x},${y} ${x + r},${y}H${x + barW - r}Q${x + barW},${y} ${x + barW},${y + r}V${py(0)}Z`}
                      fill={`url(#${id}-${k})`}
                    />
                  );
                })}
                {/* 命中区比柱子大：整格高度 */}
                <rect
                  x={PAD.left + step * i}
                  y={PAD.top}
                  width={step}
                  height={Math.max(plotH, 0)}
                  fill="transparent"
                  onMouseEnter={() => setHover(i)}
                  onMouseLeave={() => setHover(null)}
                />
              </g>
            );
          })}
        </svg>
      )}
      {hover !== null && (
        <Tip x={PAD.left + step * hover + step / 2} y={PAD.top} width={width}>
          <b>{labels[hover]}</b>
          {series.map((s) => (
            <span key={s.name}>
              <i style={{ background: s.color }} />
              {s.name}
              <em>
                {s.values[hover] ?? 0}
                {unit}
              </em>
            </span>
          ))}
        </Tip>
      )}
    </div>
  );
}
