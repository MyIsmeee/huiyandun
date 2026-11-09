import type { ThreeEvent } from "@react-three/fiber";
import { useEffect, useState } from "react";
import { DoubleSide } from "three";
import { DeviceMarkers } from "../scene/DeviceMarkers";
import type { Camera } from "../scene/devices";
import { normalizedYaw } from "./cameras";
import { placeCamera } from "./draft";

/** 拖动短于此距离（米）视为单击：保留原来的朝向 */
const DRAG_M = 0.5;
/** 朝向按 5° 取整 */
const YAW_STEP = 5;

const point = (e: ThreeEvent<PointerEvent>): [number, number] => [e.point.x, e.point.z];

/**
 * 放置摄像头（设计 150 E-5）：按下处为安装位置（按 0.5 m 吸附，留在区域内），按住拖动的方向为朝向，松开即放下；
 * 预览为该摄像头的机身与视场
 */
export function CameraPlacing({ camera, size }: { camera: Camera; size: [number, number] }) {
  const [hover, setHover] = useState<[number, number] | null>(null);
  const [from, setFrom] = useState<[number, number] | null>(null);
  const at = from ?? hover;
  const snapped = at && ([0, 1] as const).map((k) => Math.min(Math.max(Math.round(at[k] * 2) / 2, 0.5), size[k] - 0.5));
  const dragged = from && hover && Math.hypot(hover[0] - from[0], hover[1] - from[1]) > DRAG_M;
  const yaw = dragged
    ? normalizedYaw(Math.round((Math.atan2(hover[1] - from[1], hover[0] - from[0]) * 180) / Math.PI / YAW_STEP) * YAW_STEP)
    : camera.pose.yaw_deg;
  const placement = snapped && { id: camera.id, x: snapped[0] ?? 0, y: snapped[1] ?? 0, yaw_deg: normalizedYaw(yaw) };

  // 在画布外松开同样放下
  useEffect(() => {
    if (!from) return;
    const end = () => {
      if (placement) placeCamera(placement);
      setFrom(null);
    };
    window.addEventListener("pointerup", end);
    return () => window.removeEventListener("pointerup", end);
  });

  return (
    <>
      <mesh
        rotation-x={-Math.PI / 2}
        position={[size[0] / 2, 0, size[1] / 2]}
        onPointerMove={(e) => setHover(point(e))}
        onPointerOut={() => !from && setHover(null)}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.stopPropagation();
          setFrom(point(e));
          setHover(point(e));
        }}
      >
        <planeGeometry args={[size[0] + 40, size[1] + 40]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} side={DoubleSide} />
      </mesh>
      {placement && <DeviceMarkers cameras={[{ ...camera, pose: { ...camera.pose, x: placement.x, y: placement.y, yaw_deg: placement.yaw_deg } }]} />}
    </>
  );
}
