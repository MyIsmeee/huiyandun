import { useLoader } from "@react-three/fiber";
import { useMemo } from "react";
import { BufferGeometry, Matrix4, type Mesh, type Object3D, Quaternion, Vector3 } from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { mergeGeometries, mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import type { Part, Vec3 } from "./pose";
import type { Baked } from "./vehicles";

/** 人形零件：各骨段的部位，加上不属于骨段的头 */
export type FigurePart = Part | "head";

/**
 * 人形零件（§5.1 L4）：团队在 Blender 中制作的中性人偶零件（tools/dev/figure_parts.py 生成，可手工细修），
 * 逐段摆到重建出的关节上，不带骨骼与动画：姿态仍完全来自关键点。约定见 web/console/assets/figure/README.md：
 * 零件原点在近端关节，沿 +y 伸向远端关节，两关节相距 length（米，标准体型的骨长）；x 为人体左右。
 * - node：glb 中的物体名
 * - length：标准骨长，实际骨长与之不同时沿骨段拉伸（标准体型下不拉伸）；头不随骨长缩放
 * - reverse：零件自骨段的 to 一端伸向 from（躯干的骨段是肩中 → 髋中，零件自髋中向上）
 * - count：每人至多几件，决定图层容量
 */
export const PARTS: Record<FigurePart, { node: string; length?: number; reverse?: boolean; count: number }> = {
  torso: { node: "torso", length: 0.5, reverse: true, count: 1 },
  neck: { node: "neck", length: 0.22, count: 1 },
  upperArm: { node: "upper_arm", length: 0.3, count: 2 },
  forearm: { node: "forearm", length: 0.26, count: 2 },
  thigh: { node: "thigh", length: 0.42, count: 2 },
  shin: { node: "shin", length: 0.42, count: 2 },
  foot: { node: "foot", length: 0.19, count: 2 },
  head: { node: "head", count: 1 },
};
export const FIGURE_PARTS = Object.keys(PARTS) as FigurePart[];
const URL = "/models/figure-parts.glb";

/**
 * 从加载的 glb 中取出名为 node 的零件：合并其下全部网格，只留位置与法线（颜色由实例给出）；
 * 另生成沿法线外扩 outline_m 的描边外壳。GLTFLoader 遇到物体与网格同名会给物体名加后缀，原名在 userData.name 中
 */
export function bakePart(root: Object3D, node: string, outline_m: number): Baked {
  root.updateMatrixWorld(true);
  let found: Object3D | undefined;
  root.traverse((o) => {
    if (!found && ((o.userData as { name?: string }).name ?? o.name) === node) found = o;
  });
  const meshes: BufferGeometry[] = [];
  found?.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh) return;
    const source = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
    if (!source.getAttribute("normal")) source.computeVertexNormals();
    const part = new BufferGeometry();
    part.setAttribute("position", source.getAttribute("position"));
    part.setAttribute("normal", source.getAttribute("normal"));
    meshes.push(part.applyMatrix4(mesh.matrixWorld));
  });
  if (meshes.length === 0) throw new Error(`${URL} 中没有零件 ${node}`);
  const geometry = mergeGeometries(meshes);
  geometry.computeBoundingBox();
  const shell = new BufferGeometry();
  shell.setAttribute("position", geometry.getAttribute("position").clone());
  const outline = mergeVertices(shell); // 合并同位顶点再求法线：外扩时不开裂
  outline.computeVertexNormals();
  const p = outline.getAttribute("position");
  const n = outline.getAttribute("normal");
  for (let i = 0; i < p.count; i += 1)
    p.setXYZ(i, p.getX(i) + n.getX(i) * outline_m, p.getY(i) + n.getY(i) * outline_m, p.getZ(i) + n.getZ(i) * outline_m);
  return { geometry, outline };
}

/** 加载并处理全部人形零件；加载期间挂起，场景就绪即零件就绪 */
export function useFigureParts(outline_m: number): Record<FigurePart, Baked> {
  const gltf = useLoader(GLTFLoader, URL);
  return useMemo(
    () => Object.fromEntries(FIGURE_PARTS.map((part) => [part, bakePart(gltf.scene, PARTS[part].node, outline_m)])) as Record<FigurePart, Baked>,
    [gltf, outline_m],
  );
}

const UP = new Vector3(0, 1, 0);
const [x, y, z, origin, scale] = [new Vector3(), new Vector3(), new Vector3(), new Vector3(), new Vector3()];
const rotation = new Quaternion();
const basis = new Matrix4();

/**
 * 把零件摆到骨段 from → to 上的变换，写入 out（偏移 at 为人形所在的场景位置）：原点在近端关节，+y 指向远端关节并按骨长拉伸。
 * side 给定时零件的 +x 取它垂直于骨段的分量（躯干为右肩 → 左肩；脚为使 +z 朝脚背的方向），否则绕骨段的转角任意（回转体）。
 * 两端重合时朝上、不拉伸
 */
export function placePart(part: FigurePart, from: Vec3, to: Vec3, side: Vec3 | undefined, at: Vec3, out: Matrix4): Matrix4 {
  const { length, reverse } = PARTS[part];
  const [a, b] = reverse ? [to, from] : [from, to];
  origin.set(at[0] + a[0], at[1] + a[1], at[2] + a[2]);
  y.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const span = y.length();
  if (span < 1e-6) y.copy(UP);
  else y.divideScalar(span);
  if (side) {
    x.set(side[0], side[1], side[2]);
    x.addScaledVector(y, -y.dot(x));
  }
  if (side && x.lengthSq() > 1e-12) {
    x.normalize();
    z.crossVectors(x, y);
    rotation.setFromRotationMatrix(basis.makeBasis(x, y, z));
  } else rotation.setFromUnitVectors(UP, y);
  scale.set(1, length && span >= 1e-6 ? span / length : 1, 1);
  return out.compose(origin, rotation, scale);
}
