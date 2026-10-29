import type { Site } from "../lib/api";
import { GROUND_M, type PlanView } from "./layout";

/** 无 WebGL2 时的 2D 俯视视图（C-FE-08），图层与配色同 3D 场景（§5.1）；平面图不显示，随相机旋转与缩放 */
export function Scene2D({ site, view }: { site: Site; view: PlanView }) {
  const [x0, y0] = [Math.round(site.width_m / 2 - GROUND_M / 2), Math.round(site.height_m / 2 - GROUND_M / 2)];
  const grid: string[] = [];
  for (let k = 0; k <= GROUND_M; k += 1) grid.push(`M${x0 + k} ${y0}v${GROUND_M}M${x0} ${y0 + k}h${GROUND_M}`);
  return (
    <svg aria-hidden className="absolute inset-0 size-full">
      <g transform={view.transform}>
        <rect x={x0} y={y0} width={GROUND_M} height={GROUND_M} className="fill-ground" />
        <path d={grid.join("")} vectorEffect="non-scaling-stroke" className="fill-none stroke-grid" />
      </g>
    </svg>
  );
}
