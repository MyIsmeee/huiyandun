import { type ThreeEvent, useLoader, useThree } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import {
  type BufferGeometry,
  DataTexture,
  type InstancedMesh,
  LinearFilter,
  type Material,
  type Matrix4,
  type Mesh,
  MeshLambertMaterial,
  type MeshStandardMaterial,
  type Object3D,
} from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { footprints, instances, MATERIALS, type SceneItem, useCatalog } from "./assets";
import type { Area } from "./layout";

/** 地面在区域外渐隐到页面底色的距离，单位米：看不到地面的边（设计 150 §4） */
const FADE_M = 15;
/** 渐隐贴图每米的像素数 */
const FADE_PX_PER_M = 2;
/** 放置预览的不透明度 */
const GHOST_OPACITY = 0.5;

/** 资产的一个网格：已烘焙到资产局部坐标，实例矩阵直接作用其上 */
interface Part {
  geometry: BufferGeometry;
  material: Material;
}

/**
 * 当前区域的搭建场景（D-120、设计 150 §9）：管理员放置的成品模型，同一资产的全部实例合并为一次绘制（V-P1）。
 * 只用实体材质与固定光照（D-111），模型自带的调色板贴图保留明暗层次
 */
/** 场景页按下物体时：该物体在 items 中的下标与原始事件（设计 150 E-4） */
export type OnPick = (index: number, event: ThreeEvent<PointerEvent>) => void;

export function AreaScene({ area, items, onPick }: { area: Area; items: SceneItem[]; onPick?: OnPick }) {
  return (
    <>
      <Ground area={area} />
      <AssetModels items={items} onPick={onPick} />
    </>
  );
}

/** 一组物体的模型，不含地面；ghost 为场景页放置时的半透明预览（设计 150 E-2），不投射阴影 */
export function AssetModels({ items, ghost = false, onPick }: { items: SceneItem[]; ghost?: boolean; onPick?: OnPick }) {
  const catalog = useCatalog();
  const groups = useMemo(() => instances(footprints(items, catalog)), [items, catalog]);
  // 每个资产的第 k 个实例属于哪件物体：与 instances 同样按物体、分段的顺序排列
  const owners = useMemo(() => {
    const map = new Map<string, number[]>();
    items.forEach((item, i) => {
      for (const f of footprints([item], catalog)) map.set(f.asset.id, [...(map.get(f.asset.id) ?? []), i]);
    });
    return map;
  }, [items, catalog]);
  // 一次加载整个资产库（约 2 MB，同源）：之后放入新类别的物体不再挂起，场景不会因加载新模型而整体闪空
  const files = useMemo(() => [...new Set([...catalog.values()].map((a) => `/models/${a.file}`))].sort(), [catalog]);
  const pick = onPick && ((id: string, k: number, e: ThreeEvent<PointerEvent>) => onPick(owners.get(id)?.[k] ?? -1, e));
  return <Models files={files} groups={groups} ghost={ghost} onPick={pick} />;
}

function Models(props: {
  files: string[];
  groups: Map<string, Matrix4[]>;
  ghost: boolean;
  onPick?: (id: string, instance: number, event: ThreeEvent<PointerEvent>) => void;
}) {
  const { files, groups, ghost, onPick } = props;
  const gltfs = useLoader(GLTFLoader, files);
  // 只随用到的资产变化重新烘焙：移动、增删同类物体只更新实例矩阵
  const ids = useMemo(() => [...groups.keys()].sort().join(" "), [groups]);
  const parts = useMemo(() => {
    const scenes = gltfs.flatMap((g) => g.scenes);
    return new Map(ids.split(" ").filter(Boolean).map((id) => [id, bake(scenes.find((s) => s.name === id), ghost)]));
  }, [gltfs, ids, ghost]);
  useEffect(
    () => () => {
      for (const list of parts.values()) for (const { geometry, material } of list) {
        geometry.dispose();
        material.dispose();
      }
    },
    [parts],
  );
  return [...groups].flatMap(([id, matrices]) =>
    (parts.get(id) ?? []).map((part, i) => (
      <Batch
        key={`${id}/${i}`}
        part={part}
        matrices={matrices}
        shadow={!ghost}
        onPointerDown={onPick && ((e) => e.instanceId !== undefined && onPick(id, e.instanceId, e))}
      />
    )),
  );
}

/** 把资产场景中的网格烘焙到资产局部坐标；材质改为受光的 Lambert，只保留底色与贴图；预览为半透明 */
function bake(scene: Object3D | undefined, ghost: boolean): Part[] {
  if (!scene) return [];
  scene.updateMatrixWorld(true);
  const parts: Part[] = [];
  scene.traverse((node) => {
    const mesh = node as Mesh;
    if (!mesh.isMesh) return;
    const source = mesh.material as MeshStandardMaterial;
    parts.push({
      geometry: mesh.geometry.clone().applyMatrix4(mesh.matrixWorld),
      material: new MeshLambertMaterial({ color: source.color, map: source.map, transparent: ghost, opacity: ghost ? GHOST_OPACITY : 1 }),
    });
  });
  return parts;
}

function Batch(props: { part: Part; matrices: Matrix4[]; shadow: boolean; onPointerDown?: (e: ThreeEvent<PointerEvent>) => void }) {
  const { part, matrices, shadow, onPointerDown } = props;
  const ref = useRef<InstancedMesh>(null);
  const invalidate = useThree((s) => s.invalidate);
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    matrices.forEach((m, i) => mesh.setMatrixAt(i, m));
    mesh.instanceMatrix.needsUpdate = true;
    // 视锥剔除用整组实例的包围球，须按实例位置重算
    mesh.computeBoundingSphere();
    invalidate();
  }, [matrices, invalidate]);
  // 实例数变化时重建：InstancedMesh 的容量在创建时确定
  return (
    // 只有传入 onPointerDown（场景页可选中的物体）时才参与射线拾取
    <instancedMesh
      key={matrices.length}
      ref={ref}
      args={[part.geometry, part.material, matrices.length]}
      castShadow={shadow}
      receiveShadow={shadow}
      {...(onPointerDown && { onPointerDown })}
    />
  );
}

/** 地面：不受光，区域内为地面色，区域外 FADE_M 内渐隐为透明、露出页面底色；不画边框与网格（设计 150 §4）。阴影由承接面绘制 */
function Ground({ area }: { area: Area }) {
  const { width_m: w, height_m: d } = area;
  const fade = useMemo(() => fadeTexture(w, d), [w, d]);
  useEffect(() => () => fade.dispose(), [fade]);
  return (
    <mesh rotation-x={-Math.PI / 2} position={[area.x0 + w / 2, -0.004, area.y0 + d / 2]} renderOrder={-2} raycast={() => undefined}>
      <planeGeometry args={[w + FADE_M * 2, d + FADE_M * 2]} />
      <meshBasicMaterial color={MATERIALS.ground} alphaMap={fade} transparent depthWrite={false} />
    </mesh>
  );
}

/** 渐隐贴图（alphaMap 取绿色通道）：到区域矩形的距离 0 → FADE_M 由 1 平滑降到 0 */
export function fadeTexture(w: number, d: number): DataTexture {
  const [nx, ny] = [Math.ceil((w + FADE_M * 2) * FADE_PX_PER_M), Math.ceil((d + FADE_M * 2) * FADE_PX_PER_M)];
  const data = new Uint8Array(nx * ny * 4);
  for (let j = 0; j < ny; j += 1)
    for (let i = 0; i < nx; i += 1) {
      const [x, y] = [((i + 0.5) / nx) * (w + FADE_M * 2) - FADE_M, ((j + 0.5) / ny) * (d + FADE_M * 2) - FADE_M];
      const t = Math.min(1, Math.hypot(Math.max(0, -x, x - w), Math.max(0, -y, y - d)) / FADE_M);
      data.fill(Math.round(255 * (1 - t * t * (3 - 2 * t))), (j * nx + i) * 4, (j * nx + i) * 4 + 4);
    }
  const texture = new DataTexture(data, nx, ny);
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearFilter;
  texture.needsUpdate = true;
  return texture;
}
