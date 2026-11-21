import { useEffect, useMemo, useState } from "react";
import { useLive } from "../store/live";
import { footprints, MATERIALS, OUTLINE, type SceneItem, useCatalog } from "./assets";
import { BODY, type Camera, deviceLook } from "./devices";
import type { Area, PlanView } from "./layout";
import { release, retain, smoothed } from "./smoothing";
import { FILL, visibleTargets } from "./targets";

/** 物体俯视的填充色，取场景材质；描边统一取屋顶灰，在浅色底上可辨 */
const FILLS: Record<string, string> = {
  building: MATERIALS.wall,
  road: MATERIALS.road,
  wall: MATERIALS.wallShade,
  opening: MATERIALS.wallShade,
  furniture: MATERIALS.furniture,
  equipment: MATERIALS.furniture,
  greenery: MATERIALS.grass,
};
const EDGE = MATERIALS.roof;
/** 摄像头与人员的俯视半径，单位米 */
const CAMERA_R = 0.5;
const TARGET_R = 0.4;
/** 视场扇形的弧分段数 */
const ARC_STEPS = 8;

/**
 * 无 WebGL2 时的 2D 俯视视图（C-FE-08、设计 150 §9）：区域内物体的占地、摄像头与视场、检出目标，配色同 3D 场景；
 * 画出区域边线、不画网格（与 3D 一致），随相机旋转与缩放
 */
export function Scene2D({ items, cameras, view, area }: { items: SceneItem[]; cameras: Camera[]; view: PlanView; area?: Area }) {
  return (
    <svg aria-hidden className="absolute inset-0 size-full">
      <g transform={view.transform}>
        {area && (
          <rect x={area.x0} y={area.y0} width={area.width_m} height={area.height_m} fill={MATERIALS.ground} stroke={OUTLINE} strokeWidth={0.08} />
        )}
        {items.length > 0 && <Footprints items={items} />}
        {cameras.map((camera) => (
          <CameraTopDown key={camera.id} camera={camera} />
        ))}
        <Targets cameras={cameras} />
      </g>
    </svg>
  );
}

export function Footprints({ items }: { items: SceneItem[] }) {
  const catalog = useCatalog();
  return footprints(items, catalog).map(({ asset, x, y, length, width, rot }, i) => (
    <rect
      key={i}
      x={-length / 2}
      y={-width / 2}
      width={length}
      height={width}
      transform={`translate(${x} ${y}) rotate(${rot})`}
      fill={FILLS[asset.category] ?? BODY}
      stroke={EDGE}
      strokeWidth={0.1}
    />
  ));
}

/** 摄像头：视场扇形（颜色与不透明度同 3D 视场）与机身圆点 */
export function CameraTopDown({ camera }: { camera: Camera }) {
  const { x, y, yaw_deg, hfov_deg, range_m } = camera.pose;
  const look = deviceLook(camera.state);
  const fan = Array.from({ length: ARC_STEPS + 1 }, (_, k) => {
    const a = ((yaw_deg - hfov_deg / 2 + (hfov_deg * k) / ARC_STEPS) * Math.PI) / 180;
    return `${x + range_m * Math.cos(a)},${y + range_m * Math.sin(a)}`;
  });
  return (
    <g opacity={look.opacity}>
      {look.cone && <polygon points={[`${x},${y}`, ...fan].join(" ")} fill={look.cone.color} fillOpacity={look.cone.opacity} />}
      <circle cx={x} cy={y} r={CAMERA_R} fill={look.fill ?? "none"} stroke={look.outline?.color ?? EDGE} strokeWidth={0.1} />
    </g>
  );
}

/** 检出目标：滤波后的最新位置（V-A7），随推送更新、不逐帧动画 */
function Targets({ cameras }: { cameras: Camera[] }) {
  const targets = useLive((s) => s.targets);
  const behaviors = useLive((s) => s.behaviors);
  const visible = useMemo(() => visibleTargets(targets, cameras, behaviors), [targets, cameras, behaviors]);
  // 平滑状态与画面叠加共用（smoothing.ts）：只声明本视图画出的目标，卸载时撤销
  const [owner] = useState(() => ({}));
  useEffect(() => retain(owner, new Set(visible.map((t) => t.key))), [owner, visible]);
  useEffect(() => () => release(owner), [owner]);
  return visible.map((t) => {
    const [x, y] = smoothed(t.key, t).position(Number.POSITIVE_INFINITY);
    return <circle key={t.key} cx={x} cy={y} r={TARGET_R} fill={FILL} />;
  });
}
