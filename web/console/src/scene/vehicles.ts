import { useLoader } from "@react-three/fiber";
import { useMemo } from "react";
import { BufferAttribute, BufferGeometry, type Mesh, type Object3D } from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { mergeGeometries, mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import type { TargetClass } from "../store/live";

export type Vehicle = Exclude<TargetClass, "person">;

/**
 * 车辆模型（§5.1 L4，REUSE-13，来源与许可登记于 deploy/third-party.yaml）：本地打包的 CC0 成品模型，原样分发。
 * length_m 为统一缩放后的车长：轿车、自行车、摩托车取常见尺寸；货车与公交是卡通比例，按真实车长放大会过宽过高，取折中值。
 * yaw 把模型车头转到局部 +x（行进方向）。
 */
const SPECS: Record<Vehicle, { url: string; length_m: number; yaw: number }> = {
  car: { url: "/models/quaternius-car.glb", length_m: 4.5, yaw: Math.PI / 2 },
  truck: { url: "/models/quaternius-truck.glb", length_m: 6.5, yaw: Math.PI / 2 },
  bus: { url: "/models/quaternius-bus.obj", length_m: 8, yaw: Math.PI },
  bicycle: { url: "/models/quaternius-bicycle.obj", length_m: 1.75, yaw: -Math.PI / 2 },
  motorcycle: { url: "/models/alicecassie-motorcycle.glb", length_m: 2.1, yaw: -Math.PI / 2 },
};
const VEHICLES = Object.keys(SPECS) as Vehicle[];

export interface Baked {
  /** 合并后的网格，顶点色为部件明度 */
  geometry: BufferGeometry;
  /** 沿平滑法线外扩的外壳，以背面绘制为细描边 */
  outline: BufferGeometry;
}

/** 部件明度：轮胎与深色件 0.3、车窗 0.55、其余（车身）1；单色按明度区分部件，不引入新色相（UP-2） */
export function shadeOf(name: string): number {
  if (/wheel|tire|black|dark/i.test(name)) return 0.3;
  if (/window|glass/i.test(name)) return 0.55;
  return 1;
}

/**
 * 把一个模型烘焙为单个几何体：合并全部网格，按网格、其上级节点与材质名写入明度顶点色，丢弃贴图；
 * 车头转到 +x、等比缩放到 length_m、底面落地、水平居中；另生成外扩 outline_m 的描边外壳。
 */
export function bake(root: Object3D, length_m: number, yaw: number, outline_m: number): Baked {
  root.updateMatrixWorld(true);
  const parts: BufferGeometry[] = [];
  root.traverse((node) => {
    const mesh = node as Mesh;
    if (!mesh.isMesh) return;
    const names: string[] = [];
    for (let n: Object3D | null = mesh; n; n = n.parent) names.push(n.name);
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const source = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry;
    const position = source.getAttribute("position");
    const groups = source.groups.length > 0 ? source.groups : [{ start: 0, count: position.count, materialIndex: 0 }];
    const color = new Float32Array(position.count * 3);
    for (const { start, count, materialIndex = 0 } of groups) {
      const shade = shadeOf(`${names.join(" ")} ${materials[materialIndex]?.name ?? ""}`);
      color.fill(shade, start * 3, Math.min(start + count, position.count) * 3);
    }
    const part = new BufferGeometry();
    part.setAttribute("position", position.clone());
    part.setAttribute("color", new BufferAttribute(color, 3));
    part.computeVertexNormals();
    parts.push(part.applyMatrix4(mesh.matrixWorld));
  });
  const geometry = mergeGeometries(parts).rotateY(yaw);
  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  if (box) {
    const scale = length_m / (box.max.x - box.min.x);
    geometry.translate(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2).scale(scale, scale, scale);
  }
  const shell = new BufferGeometry();
  shell.setAttribute("position", geometry.getAttribute("position").clone());
  const outline = mergeVertices(shell); // 合并同位顶点再求法线：外扩时棱角处不开裂
  outline.computeVertexNormals();
  const p = outline.getAttribute("position");
  const n = outline.getAttribute("normal");
  for (let i = 0; i < p.count; i += 1)
    p.setXYZ(i, p.getX(i) + n.getX(i) * outline_m, p.getY(i) + n.getY(i) * outline_m, p.getZ(i) + n.getZ(i) * outline_m);
  return { geometry, outline };
}

const GLB = VEHICLES.filter((v) => SPECS[v].url.endsWith(".glb"));
const OBJ = VEHICLES.filter((v) => SPECS[v].url.endsWith(".obj"));

/** 加载并烘焙全部车辆模型；加载期间挂起，场景就绪即模型就绪 */
export function useVehicleModels(outline_m: number): Record<Vehicle, Baked> {
  const gltf = useLoader(
    GLTFLoader,
    GLB.map((v) => SPECS[v].url),
  );
  const obj = useLoader(
    OBJLoader,
    OBJ.map((v) => SPECS[v].url),
  );
  return useMemo(() => {
    const classes = [...GLB, ...OBJ];
    const roots = [...gltf.map((g) => g.scene), ...obj];
    return Object.fromEntries(
      roots.map((root, i) => {
        const { length_m, yaw } = SPECS[classes[i] as Vehicle];
        return [classes[i], bake(root, length_m, yaw, outline_m)];
      }),
    ) as Record<Vehicle, Baked>;
  }, [gltf, obj, outline_m]);
}
