import { useLoader } from "@react-three/fiber";
import { useMemo } from "react";
import type { BufferGeometry, Object3D } from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import type { SceneFrame } from "../store/live";
import { bake } from "./vehicles";

type ObjectClass = SceneFrame["objects"][number]["class"];
export type Furniture = Extract<ObjectClass, "table" | "chair" | "cabinet" | "sofa" | "bed">;

/**
 * 家具模型（§5.1 L1，REUSE-13，D-059，来源与许可登记于 deploy/third-party.yaml）：Quaternius 的 CC0 成品模型，原样分发。
 * width_m 为沿识别区域排开时每件的标准宽度；yaw 把模型正面转到局部 +z、沿排开方向的一边转到局部 x（桌、床的长边沿排开方向）
 */
const SPECS: Record<Furniture, { url: string; width_m: number; yaw: number }> = {
  table: { url: "/models/quaternius-table.glb", width_m: 1.2, yaw: Math.PI / 2 },
  chair: { url: "/models/quaternius-chair.glb", width_m: 0.5, yaw: 0 },
  cabinet: { url: "/models/quaternius-closet.glb", width_m: 0.9, yaw: 0 },
  sofa: { url: "/models/quaternius-sofa.glb", width_m: 2, yaw: 0 },
  bed: { url: "/models/quaternius-bed.glb", width_m: 2, yaw: Math.PI / 2 },
};
const FURNITURE = Object.keys(SPECS) as Furniture[];
/** 部件明度的下限：车辆的 0.3～1 映射到 0.72～1 */
const FLOOR_SHADE = 0.6;

export const isFurniture = (c: ObjectClass): c is Furniture => c in SPECS;
export const widthOf = (c: Furniture) => SPECS[c].width_m;

/** 排开的一件：平面中心、绕竖直轴的转角（局部 +z 转到平面 (sin yaw, cos yaw)）、沿排开方向的宽与深 */
export interface Placement {
  x: number;
  y: number;
  yaw: number;
  width: number;
  depth: number;
}

/**
 * 一片相连的同类家具按标准宽度沿识别区域排开（D-059）：取底面轮廓顶点的主轴为排开方向，
 * 张数为长度除以标准宽度四舍五入（至少一件）、均分长度，深取次轴范围；正面朝向摄像头一侧
 */
export function arrange(polygon: number[][], width_m: number, camera: [number, number]): Placement[] {
  const n = polygon.length;
  const [mx, my] = [0, 1].map((k) => polygon.reduce((s, p) => s + (p[k] ?? 0), 0) / n) as [number, number];
  let [sxx, syy, sxy] = [0, 0, 0];
  for (const [x = 0, y = 0] of polygon) {
    sxx += (x - mx) ** 2;
    syy += (y - my) ** 2;
    sxy += (x - mx) * (y - my);
  }
  const angle = Math.atan2(2 * sxy, sxx - syy) / 2;
  const u = [Math.cos(angle), Math.sin(angle)] as const;
  const v = [-u[1], u[0]] as const;
  const along = polygon.map(([x = 0, y = 0]) => (x - mx) * u[0] + (y - my) * u[1]);
  const across = polygon.map(([x = 0, y = 0]) => (x - mx) * v[0] + (y - my) * v[1]);
  const [u0, u1, v0, v1] = [Math.min(...along), Math.max(...along), Math.min(...across), Math.max(...across)];
  const length = u1 - u0;
  const mid = (v0 + v1) / 2;
  const [cx, cy] = [mx + u[0] * (u0 + u1) / 2 + v[0] * mid, my + u[1] * (u0 + u1) / 2 + v[1] * mid];
  const side = Math.sign((camera[0] - cx) * v[0] + (camera[1] - cy) * v[1]) || 1;
  const yaw = Math.atan2(side * v[0], side * v[1]);
  const count = Math.max(1, Math.round(length / width_m));
  return Array.from({ length: count }, (_, i) => {
    const t = u0 + ((i + 0.5) * length) / count;
    return { x: mx + u[0] * t + v[0] * mid, y: my + u[1] * t + v[1] * mid, yaw, width: length / count, depth: v1 - v0 };
  });
}

/**
 * 把一个家具模型烘焙为单位尺寸：宽、高、深均为 1，底面落地、水平居中，正面转到局部 +z；
 * 顶点色为部件明度，深色部件（深色木纹桌面、床架）按车辆明度会压成大块深灰，提亮到 0.72～1，仍可分辨部件
 */
export function bakeUnit(root: Object3D, yaw: number): BufferGeometry {
  const { geometry, outline } = bake(root, 1, yaw, 0);
  outline.dispose();
  const box = geometry.boundingBox;
  if (box) geometry.scale(1, 1 / (box.max.y - box.min.y), 1 / (box.max.z - box.min.z));
  const shade = geometry.getAttribute("color");
  for (let k = 0; k < shade.array.length; k += 1) shade.array[k] = FLOOR_SHADE + (1 - FLOOR_SHADE) * (shade.array[k] ?? 1);
  return geometry;
}

/** 加载并烘焙全部家具模型为单位尺寸（bakeUnit）；加载期间挂起 */
export function useFurnitureModels(): Record<Furniture, BufferGeometry> {
  const gltf = useLoader(
    GLTFLoader,
    FURNITURE.map((f) => SPECS[f].url),
  );
  return useMemo(
    () =>
      Object.fromEntries(
        gltf.map(({ scene }, i) => [FURNITURE[i], bakeUnit(scene, SPECS[FURNITURE[i] as Furniture].yaw)]),
      ) as Record<Furniture, BufferGeometry>,
    [gltf],
  );
}
