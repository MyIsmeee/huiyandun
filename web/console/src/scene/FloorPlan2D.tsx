import type { Site } from "../lib/api";
import { type View, WALL_THICKNESS_M } from "./layout";
import { wallPieces } from "./walls";

/** 无 WebGL2 时的 2D 俯视平面图（C-FE-08），图层与配色同 3D 场景（§5.1）；门洞处墙体断开 */
export function FloorPlan2D({ site, view }: { site: Site; view: View }) {
  const [left, top] = view.project([0, 0, 0]);
  const grid: string[] = [];
  for (let x = 0; x <= site.width_m; x += 1) grid.push(`M${x} 0V${site.height_m}`);
  for (let y = 0; y <= site.height_m; y += 1) grid.push(`M0 ${y}H${site.width_m}`);
  return (
    <svg aria-hidden className="absolute inset-0 size-full">
      <g transform={`translate(${left} ${top}) scale(${view.zoom})`}>
        <rect width={site.width_m} height={site.height_m} className="fill-raised" />
        <path d={grid.join("")} vectorEffect="non-scaling-stroke" className="fill-none stroke-grid" />
        {site.zones.map((zone) => (
          <polygon
            key={zone.id}
            points={zone.polygon.map(([x, y]) => `${x},${y}`).join(" ")}
            vectorEffect="non-scaling-stroke"
            className="fill-fg-2/8 stroke-fg-2"
          />
        ))}
        {wallPieces(site.walls, site.doors)
          .filter((piece) => piece.bottom === 0) // 俯视看不到门楣
          .map(({ from: [x1, y1], to: [x2, y2] }, i) => (
          <line
            key={i}
            x1={x1}
            y1={y1}
            x2={x2}
            y2={y2}
            strokeWidth={WALL_THICKNESS_M}
            className="stroke-fg-3"
          />
        ))}
      </g>
    </svg>
  );
}
