import type { Site } from "../lib/api";
import type { SceneFrame } from "../store/live";
import { useTheme } from "../theme/store";
import type { Camera } from "./devices";
import { GROUND_M, type PlanView } from "./layout";
import { largestFirst, PALETTE, type Palette, STALE_OPACITY, useScenes } from "./perceived";

/** 立面俯视为线条：外圈取栅格色勾边，在浅色地面上可辨 */
const WALL_WIDTH_M = 0.25;
const EDGE_M = 0.1;
/** 树冠俯视半径与树高之比，与 3D 树冠一致 */
const CROWN_RATIO = 0.35;

const points = (polygon: number[][]) => polygon.map(([x, y]) => `${x},${y}`).join(" ");

/** 无 WebGL2 时的 2D 俯视视图（C-FE-08），图层与配色同 3D 场景（§5.1）；平面图不显示，随相机旋转与缩放 */
export function Scene2D({ site, cameras, view }: { site: Site; cameras: Camera[]; view: PlanView }) {
  const palette = PALETTE[useTheme((s) => s.theme)];
  const scenes = useScenes(cameras);
  const [x0, y0] = [Math.round(site.width_m / 2 - GROUND_M / 2), Math.round(site.height_m / 2 - GROUND_M / 2)];
  const grid: string[] = [];
  for (let k = 0; k <= GROUND_M; k += 1) grid.push(`M${x0 + k} ${y0}v${GROUND_M}M${x0} ${y0 + k}h${GROUND_M}`);
  return (
    <svg aria-hidden className="absolute inset-0 size-full">
      <g transform={view.transform}>
        <rect x={x0} y={y0} width={GROUND_M} height={GROUND_M} className="fill-ground" />
        <path d={grid.join("")} vectorEffect="non-scaling-stroke" className="fill-none stroke-grid" />
        {scenes.map(({ frame, stale }) => (
          <g key={frame.camera_id} opacity={stale ? STALE_OPACITY : 1}>
            <TopDown frame={frame} palette={palette} />
          </g>
        ))}
      </g>
    </svg>
  );
}

/** 一帧场景的俯视图：地面色块（面积从大到小）、标线、立面、物体、树冠 */
function TopDown({ frame, palette }: { frame: SceneFrame; palette: Palette }) {
  return (
    <>
      {largestFirst(frame.surfaces).map((s, i) => (
        <polygon key={`s${i}`} points={points(s.polygon)} fill={palette[s.class]} />
      ))}
      {frame.markings.map((m, i) => (
        <polygon key={`m${i}`} points={points(m.polygon)} fill={palette.marking} />
      ))}
      {frame.walls.map((w, i) => (
        <g key={`w${i}`} fill="none" strokeLinejoin="round">
          <polyline points={points(w.line)} strokeWidth={WALL_WIDTH_M + EDGE_M * 2} className="stroke-grid" />
          <polyline points={points(w.line)} strokeWidth={WALL_WIDTH_M} stroke={w.class === "board" ? palette.road : palette.facade} />
        </g>
      ))}
      {frame.objects.map((o, i) => (
        <polygon key={`o${i}`} points={points(o.polygon)} fill={palette.facade} strokeWidth={EDGE_M} className="stroke-grid" />
      ))}
      {frame.trees.map((t, i) => (
        <circle key={`t${i}`} cx={t.x} cy={t.y} r={t.height_m * CROWN_RATIO} fill={palette.grass} strokeWidth={EDGE_M} className="stroke-grid" />
      ))}
    </>
  );
}
