import { ShieldAlert } from "lucide-react";
import { useMemo } from "react";
import type { Site } from "../lib/api";
import { useLive } from "../store/live";
import { ATTACKED, attackerAnchor } from "./attack";
import { type Camera, STATUS } from "./devices";
import type { View } from "./layout";

/** 断开处的缺口占连线长度的比例 */
const GAP = 0.2;

/**
 * 攻击连线（04 §5.2、D-076）：设备处于网络攻击、处置中或只通知时，从站点边缘外的"外部攻击源"（标出 IP，取该设备
 * 最近一条网络告警的源地址）画红色虚线到设备；已处置时虚线断开并淡出（降低动效或断线时瞬时消失，V-A4、V-U3）。
 * 以视口像素绘制，3D 与 2D 降级视图共用；状态色同时配图标与文字（V-S3）。
 */
export function AttackLines({ site, cameras, view }: { site: Site; cameras: Camera[]; view: View }) {
  const alerts = useLive((s) => s.alerts);
  const sources = useMemo(() => {
    const latest = new Map<string, string>();
    for (const a of alerts) {
      if ("src_ip" in a && a.device_id && !latest.has(a.device_id)) latest.set(a.device_id, a.src_ip);
    }
    return latest;
  }, [alerts]);

  const lines = cameras.flatMap(({ id, state, pose }) => {
    const ip = sources.get(id);
    if (!ip || !(ATTACKED.has(state) || state === "contained")) return [];
    const [ax, ay] = attackerAnchor([pose.x, pose.y], site.width_m, site.height_m);
    const from = view.project([ax, 0, ay]);
    const to = view.project([pose.x, pose.height_m, pose.y]);
    if (!from || !to) return [];
    return [{ id, ip, from, to, contained: state === "contained" }];
  });
  if (lines.length === 0) return null;

  return (
    <>
      <svg aria-hidden className="pointer-events-none absolute inset-0 size-full">
        {lines.map(({ id, from, to, contained }) => {
          const [x1, y1] = from;
          const [x2, y2] = to;
          const dash = { stroke: STATUS.cyber, strokeWidth: 2, strokeDasharray: "6 4" };
          if (!contained) return <line key={id} x1={x1} y1={y1} x2={x2} y2={y2} {...dash} />;
          // 断开：去掉中段，两端各留一截后淡出
          const at = (t: number) => [x1 + (x2 - x1) * t, y1 + (y2 - y1) * t] as const;
          const [m1, m2] = [at((1 - GAP) / 2), at((1 + GAP) / 2)];
          return (
            <g key={id} data-attack-broken={id} className="animate-fade-out">
              <line x1={x1} y1={y1} x2={m1[0]} y2={m1[1]} {...dash} />
              <line x1={m2[0]} y1={m2[1]} x2={x2} y2={y2} {...dash} />
            </g>
          );
        })}
      </svg>
      {lines.map(({ id, ip, from, contained }) => (
        <span
          key={id}
          data-attacker={id}
          style={{ left: from[0], top: from[1], borderColor: STATUS.cyber }}
          className={`pointer-events-none absolute flex -translate-x-1/2 -translate-y-1/2 items-center gap-1 rounded-full border bg-panel/90 px-2 py-0.5 text-xs whitespace-nowrap text-fg ${contained ? "animate-fade-out" : ""}`}
        >
          <ShieldAlert aria-hidden className="size-3.5" style={{ color: STATUS.cyber }} />
          外部攻击源 <span className="tabular-nums">{ip}</span>
        </span>
      ))}
    </>
  );
}
