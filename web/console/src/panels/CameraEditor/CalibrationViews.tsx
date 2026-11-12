import { type MouseEvent, useState } from "react";
import type { components } from "../../api/schema";
import { useCameras } from "../../scene/devices";
import { CameraTopDown, Footprints } from "../../scene/Scene2D";
import { useLive } from "../../store/live";
import type { Snapshot } from "./CameraEditor";

/** 一组标定点：画面原始分辨率下的像素 (u, v) 与区域内地面坐标 (x, y)，单位米 */
export type Pair = [u: number, v: number, x: number, y: number];
type SceneArea = components["schemas"]["SceneArea"];

/** 编号点的半径：画面宽或区域长边的 1/70，两侧显示大小相近 */
const MARKER_RATIO = 1 / 70;

/**
 * 标定画面（V-CAM10）：点击处按画面原始尺寸换算为像素，与攀爬警戒线一致（V-CAM7）。
 * 已配对的点按编号显示，未配对的点以强调色闪烁；取不到画面时显示原因，不可标定。
 */
export function CalibrationFrame(props: {
  snapshot: Snapshot;
  pairs: Pair[];
  pending: [number, number] | null;
  hover: number | null;
  onPick: (pixel: [number, number]) => void;
}) {
  const { snapshot, pairs, pending, hover } = props;
  const [size, setSize] = useState<[number, number] | null>(null);
  if (snapshot.status !== "ready") {
    const text = snapshot.status === "failed" ? `取不到画面：${snapshot.message}` : "正在取画面…";
    return <p className="grid aspect-video place-items-center rounded-lg border border-dashed border-border text-subtle-foreground">{text}</p>;
  }
  function pick(e: MouseEvent<HTMLImageElement>) {
    const img = e.currentTarget;
    const rect = img.getBoundingClientRect();
    props.onPick([
      Math.round(((e.clientX - rect.left) / rect.width) * img.naturalWidth),
      Math.round(((e.clientY - rect.top) / rect.height) * img.naturalHeight),
    ]);
  }
  const r = size ? size[0] * MARKER_RATIO : 0;
  return (
    <div className="relative">
      <img
        src={snapshot.url}
        alt="标定画面"
        onLoad={(e) => setSize([e.currentTarget.naturalWidth, e.currentTarget.naturalHeight])}
        onClick={pick}
        className="w-full cursor-crosshair rounded-lg"
      />
      {size && (
        <svg aria-hidden viewBox={`0 0 ${size[0]} ${size[1]}`} className="pointer-events-none absolute inset-0 size-full">
          {pairs.map(([u, v], i) => (
            <Marker key={i} x={u} y={v} r={r} label={i + 1} active={hover === i} />
          ))}
          {pending && <Marker x={pending[0]} y={pending[1]} r={r} label={pairs.length + 1} pending />}
        </svg>
      )}
    </div>
  );
}

/**
 * 区域俯视图（V-CAM10）：x 向右、y 向下，按区域宽深等比居中显示；复用 Scene2D 的物体占地与摄像头俯视画法，
 * 加 1 m 网格，不画实时目标。只能在区域内点选，取 0.1 m，指针处实时显示坐标。
 */
export function GroundPlan(props: { area: SceneArea; pairs: Pair[]; hover: number | null; onPick: (ground: [number, number]) => void }) {
  const { area } = props;
  const site = useLive((s) => s.site);
  const cameras = useCameras(site?.devices ?? [], area.id);
  const [pointer, setPointer] = useState<[number, number] | null>(null);

  function groundOf(e: MouseEvent<SVGSVGElement>): [number, number] | null {
    const rect = e.currentTarget.getBoundingClientRect();
    const scale = Math.min(rect.width / area.width_m, rect.height / area.depth_m);
    const x = (e.clientX - rect.left - (rect.width - area.width_m * scale) / 2) / scale;
    const y = (e.clientY - rect.top - (rect.height - area.depth_m * scale) / 2) / scale;
    if (x < 0 || y < 0 || x > area.width_m || y > area.depth_m) return null;
    return [Math.round(x * 10) / 10, Math.round(y * 10) / 10];
  }

  return (
    <div className="flex flex-col gap-1">
      <svg
        role="img"
        aria-label="区域俯视图"
        viewBox={`0 0 ${area.width_m} ${area.depth_m}`}
        onClick={(e) => {
          const ground = groundOf(e);
          if (ground) props.onPick(ground);
        }}
        onMouseMove={(e) => setPointer(groundOf(e))}
        onMouseLeave={() => setPointer(null)}
        className="max-h-[60vh] w-full cursor-crosshair rounded-lg border border-border bg-card"
        style={{ aspectRatio: `${area.width_m} / ${area.depth_m}` }}
      >
        <Grid width={area.width_m} depth={area.depth_m} />
        {area.items.length > 0 && <Footprints items={area.items} />}
        {cameras.map((c) => (
          <CameraTopDown key={c.id} camera={c} />
        ))}
        {props.pairs.map(([, , x, y], i) => (
          <Marker key={i} x={x} y={y} r={Math.max(area.width_m, area.depth_m) * MARKER_RATIO} label={i + 1} active={props.hover === i} />
        ))}
      </svg>
      <span className="self-end text-xs text-subtle-foreground tabular-nums">
        {pointer ? `指针处 x ${pointer[0].toFixed(1)} y ${pointer[1].toFixed(1)} m` : " "}
      </span>
    </div>
  );
}

/** 编号点：悬停对应表格行时放大；未配对的点以强调色闪烁 */
function Marker(props: { x: number; y: number; r: number; label: number; active?: boolean; pending?: boolean }) {
  const r = props.active ? props.r * 1.5 : props.r;
  return (
    <g data-marker={props.label} className={props.pending ? "animate-pulse" : undefined}>
      <circle cx={props.x} cy={props.y} r={r} strokeWidth={r / 5} className={props.pending ? "fill-primary stroke-card" : "fill-foreground stroke-card"} />
      <text x={props.x} y={props.y} dy="0.35em" textAnchor="middle" fontSize={r * 1.1} className="fill-primary-foreground select-none">
        {props.label}
      </text>
    </g>
  );
}

/** 1 m 网格，只在标定俯视图中显示，便于读出位置 */
function Grid({ width, depth }: { width: number; depth: number }) {
  return (
    <g className="stroke-border" strokeWidth={0.03}>
      {Array.from({ length: width + 1 }, (_, i) => (
        <line key={`x${i}`} x1={i} y1={0} x2={i} y2={depth} />
      ))}
      {Array.from({ length: depth + 1 }, (_, i) => (
        <line key={`y${i}`} x1={0} y1={i} x2={width} y2={i} />
      ))}
    </g>
  );
}
