import { ShieldAlert } from "lucide-react";
import { useMemo } from "react";
import { StatusPill } from "@/components/StatusPill";
import { useLive } from "../store/live";
import { ATTACKED, attackerAnchor, attackSources, DASH, FADE_MS, fadeElapsed } from "./attack";
import { type Camera, STATUS } from "./devices";
import type { Area, View } from "./layout";

/** 断开处的缺口占连线长度的比例 */
const GAP = 0.2;
/** 攻击源标签与视口边缘的最小距离，单位像素 */
const EDGE_PX = 8;

/**
 * 攻击连线（ui.md §5.1、D-076）：设备处于网络攻击、处置中或只通知时，从区域边缘外的"外部攻击源"（标出 IP，取该设备
 * 最近一条网络告警的源地址，见 attackSources）画红色虚线到设备，虚线沿攻击方向流动（降低动效或断线时静止）；
 * 已处置时虚线停止流动、断开并淡出（降低动效或断线时瞬时消失，V-A4、V-U3）。
 * 淡出按进入已处置的时刻计进度：重新挂载时接着播放剩余部分，播完后不再画。
 * 以视口像素绘制，3D 与 2D 降级视图共用；状态色同时配图标与文字（V-S3）。
 */
export function AttackLines({ area, cameras, view }: { area: Area; cameras: Camera[]; view: View }) {
  const alerts = useLive((s) => s.alerts);
  const incidents = useLive((s) => s.incidents);
  const executions = useLive((s) => s.executions);
  const sources = useMemo(() => attackSources(alerts, incidents, executions), [alerts, incidents, executions]);

  const lines = cameras.flatMap(({ id, state, pose }) => {
    const ip = sources.get(id);
    const contained = state === "contained";
    const elapsed = fadeElapsed(id, contained, executions) ?? 0;
    if (!ip || !(ATTACKED.has(state) || contained)) return [];
    // 已淡出完毕：不再画（否则每次挂载都会重播一次断开动画）
    if (contained && elapsed >= FADE_MS) return [];
    const [ax, ay] = attackerAnchor([pose.x, pose.y], area);
    const from = view.project([ax, 0, ay]);
    const to = view.project([pose.x, pose.height_m, pose.y]);
    if (!from || !to) return [];
    return [{ id, ip, from, to, contained, fade: contained ? { animationDelay: `-${elapsed}ms` } : undefined }];
  });
  if (lines.length === 0) return null;

  return (
    <>
      <svg aria-hidden className="pointer-events-none absolute inset-0 size-full">
        {lines.map(({ id, from, to, contained, fade }) => {
          const [x1, y1] = from;
          const [x2, y2] = to;
          const dash = { stroke: STATUS.cyber, strokeWidth: 2, strokeDasharray: DASH.join(" ") };
          if (!contained) return <line key={id} data-attack-line={id} className="animate-dash-flow" x1={x1} y1={y1} x2={x2} y2={y2} {...dash} />;
          // 断开：去掉中段，两端各留一截后淡出
          const at = (t: number) => [x1 + (x2 - x1) * t, y1 + (y2 - y1) * t] as const;
          const [m1, m2] = [at((1 - GAP) / 2), at((1 + GAP) / 2)];
          return (
            <g key={id} data-attack-broken={id} className="animate-fade-out" style={fade}>
              <line x1={x1} y1={y1} x2={m1[0]} y2={m1[1]} {...dash} />
              <line x1={m2[0]} y1={m2[1]} x2={x2} y2={y2} {...dash} />
            </g>
          );
        })}
      </svg>
      {lines.map(({ id, ip, from, to, contained, fade }) => (
        // 标签不出视口：锚点限制在视口内，标签向设备一侧展开（攻击源在左则向右、在右则向左）
        <span
          key={id}
          data-attacker={id}
          style={{
            left: `clamp(${EDGE_PX}px, ${from[0]}px, calc(100% - ${EDGE_PX}px))`,
            top: `clamp(${EDGE_PX * 2}px, ${from[1]}px, calc(100% - ${EDGE_PX * 2}px))`,
            ...fade,
          }}
          className={`pointer-events-none absolute -translate-y-1/2 ${from[0] < to[0] ? "" : from[0] > to[0] ? "-translate-x-full" : "-translate-x-1/2"} ${contained ? "animate-fade-out" : ""}`}
        >
          <StatusPill icon={ShieldAlert} color={STATUS.cyber}>
            外部攻击源 {ip}
          </StatusPill>
        </span>
      ))}
    </>
  );
}
