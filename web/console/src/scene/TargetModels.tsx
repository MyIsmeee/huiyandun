import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import {
  BackSide,
  BufferAttribute,
  BufferGeometry,
  CircleGeometry,
  Color,
  CylinderGeometry,
  type InstancedMesh,
  Object3D,
  RingGeometry,
  SphereGeometry,
  Vector3,
} from "three";
import { TRAIL_MS, type TargetClass, useLive } from "../store/live";
import { useMotion } from "./DeviceMarkers";
import { type Camera, STATUS } from "./devices";
import { facing, type Figure, figure, HEAD_R } from "./pose";
import { LOCK_RING_MS, positionAt, RENDER_DELAY_MS, turnToward, type Visible, visibleTargets } from "./targets";
import { useVehicleModels, type Vehicle } from "./vehicles";

/** 每个图层的实例上限：C-FE-04 的 200 个目标，固定容量免得目标数变化时重建网格 */
const CAPACITY = 256;
/** 人形的骨段与关节容量：每人至多 12 段（躯干、颈部、双肩、双髋与四肢），关节为每段两端加头部 */
const BONE_CAPACITY = CAPACITY * 12;
const JOINT_CAPACITY = CAPACITY * 25;
/** 人员与车辆默认白色，带中性细描边（§5.1 L4） */
const FILL = "#F7F8FA";
const OUTLINE_M = 0.02;
const UP = new Vector3(0, 1, 0);
/** 转向角速度上限（弧度每秒）：车辆掉头约 1 s 完成，不瞬间翻转 */
const TURN_RATE = 3;
/** 轨迹顶点容量：每个目标近 10 s、每秒 5 次实测（FR-101）的连线，每段 2 个顶点 */
const TRAIL_VERTICES = CAPACITY * 2 * (TRAIL_MS / 1000) * 5;
/** 轨迹重建的最短间隔：200 个目标每秒约 1000 次推送，轨迹只需跟上实测频率（SC-10） */
const TRAIL_REBUILD_MS = 200;

/** 人形的骨段（沿 +y 的单位圆柱，按半径与长度缩放）与关节、头部（单位球）：两者拼成胶囊肢体 */
const BONE = new CylinderGeometry(1, 1, 1, 10, 1, true).translate(0, 0.5, 0);
const JOINT = new SphereGeometry(1, 12, 8);

/** 图层：实体、高误差（半透明、不投影，V-U1）、细描边（背面外扩，只画实体）；车辆带部件明度顶点色 */
type Kind = "solid" | "ghost" | "outline";
type Layer = { key: string; geometry: BufferGeometry; capacity: number; kind: Kind; shaded: boolean };
const KINDS = ["solid", "ghost", "outline"] as const;
const FIGURE_LAYERS: Layer[] = KINDS.flatMap((kind) => [
  { key: `bone/${kind}`, geometry: BONE, capacity: BONE_CAPACITY, kind, shaded: false },
  { key: `joint/${kind}`, geometry: JOINT, capacity: JOINT_CAPACITY, kind, shaded: false },
]);
/** 人形各部件要画的图层与半径：实体另画外扩 OUTLINE_M 的描边 */
const outlined = (kind: Kind, radius: number): (readonly [Kind, number])[] =>
  kind === "solid" ? [["solid", radius], ["outline", radius + OUTLINE_M]] : [[kind, radius]];
/** 不确定圆：单位半径，按 uncertainty_m 缩放（V-U1） */
const DISC = new CircleGeometry(1, 32).rotateX(-Math.PI / 2).translate(0, 0.02, 0);
/** 锁定环：新目标出现时由 0.4 扩散到 1.6 倍目标尺度（§5.1 L4） */
const RING = new RingGeometry(0.85, 1, 40).rotateX(-Math.PI / 2).translate(0, 0.04, 0);
/** 锁定环的基准半径：人员 0.6 m，车辆按车长 */
const RING_RADIUS: Record<TargetClass, number> = { person: 0.6, bicycle: 1.1, motorcycle: 1.2, car: 2.6, bus: 6, truck: 4 };

const colorOf = (t: Visible) => (t.alert ? STATUS.physical : FILL);

/**
 * 检出目标：人员的姿态人形、车辆的 3D 模型、不确定圆、锁定环与轨迹（§5.1 L4、L5；V-U1；FR-102）。
 * 模型每帧按渲染时间轴（落后最新实测 200 ms）在相邻两次实测之间插值，车辆沿运动方向转向，人形朝向摄像头；不外推。
 * 只在仍有目标移动、转向或锁定环未结束时逐帧重绘；断线或降低动效时停在最新实测位置（V-U3、V-A4）。
 */
export function TargetModels({ cameras }: { cameras: Camera[] }) {
  const meshes = useRef<Record<string, InstancedMesh | null>>({});
  const vehicles = useVehicleModels(OUTLINE_M);
  const layers = useMemo(
    () => [
      ...(Object.keys(vehicles) as Vehicle[]).flatMap((cls) =>
        KINDS.map((kind) => ({
          key: `${cls}/${kind}`,
          geometry: kind === "outline" ? vehicles[cls].outline : vehicles[cls].geometry,
          capacity: CAPACITY,
          kind,
          shaded: kind !== "outline",
        })),
      ),
      ...FIGURE_LAYERS,
    ],
    [vehicles],
  );
  const discs = useRef<InstancedMesh>(null);
  const rings = useRef<InstancedMesh>(null);
  const headings = useRef(new Map<string, number>());
  const last = useRef(0);
  // 轨迹写入预分配的缓冲区：推送频繁时不重建几何体，也不触发 React 重渲染
  const trails = useMemo(() => {
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(new Float32Array(TRAIL_VERTICES * 3), 3));
    geometry.setAttribute("color", new BufferAttribute(new Float32Array(TRAIL_VERTICES * 3), 3));
    geometry.setDrawRange(0, 0);
    return geometry;
  }, []);
  const trailSource = useRef<readonly [object, object] | null>(null);
  const trailBuilt = useRef(0);
  const motion = useMotion();
  const invalidate = useThree((s) => s.invalidate);
  // 新推送到达时请求一帧；逐帧插值由 useFrame 自行续帧
  useEffect(() => useLive.subscribe(() => invalidate()), [invalidate]);
  useEffect(() => invalidate(), [motion, cameras, invalidate]);

  useFrame(() => {
    // 只在仍有运动时续帧（见 pending）：静止时不占用 GPU，也不构成常驻动画（V-A3）
    const now = Date.now();
    // 停绘一段时间后恢复时，上一帧时刻已久：限制步长，转向不跳变
    const dt = last.current ? Math.min((now - last.current) / 1000, 0.1) : 0;
    last.current = now;
    const { targets, behaviors } = useLive.getState();
    const list = visibleTargets(targets, cameras, behaviors);
    const t = motion ? now - RENDER_DELAY_MS : Number.POSITIVE_INFINITY;
    const source = trailSource.current;
    const stale = source?.[0] !== targets || source?.[1] !== behaviors;
    if (stale && (!motion || now - trailBuilt.current >= TRAIL_REBUILD_MS)) {
      writeTrails(trails, list);
      trailSource.current = [targets, behaviors];
      trailBuilt.current = now;
    }
    const o = new Object3D();
    const counts: Record<string, number> = {};
    /** 把 o 的当前变换（与颜色）写入图层 key 的下一个实例；超出容量的不画 */
    const put = (key: string, color?: Color) => {
      const mesh = meshes.current[key];
      const i = counts[key] ?? 0;
      if (!mesh || i >= mesh.instanceMatrix.count) return;
      counts[key] = i + 1;
      mesh.setMatrixAt(i, o.matrix);
      if (color) mesh.setColorAt(i, color);
    };
    /** 球：关节与头部；实体另画外扩的描边 */
    const sphere = (at: Vector3, radius: number, kind: Kind, color: Color) => {
      o.position.copy(at);
      o.quaternion.identity();
      for (const [layer, r] of outlined(kind, radius)) {
        o.scale.setScalar(r);
        o.updateMatrix();
        put(`joint/${layer}`, layer === "outline" ? undefined : color);
      }
    };
    const drawFigure = ({ bones, head }: Figure, x: number, y: number, kind: Kind, color: Color) => {
      const from = new Vector3();
      const to = new Vector3();
      for (const bone of bones) {
        from.set(x + bone.from[0], bone.from[1], y + bone.from[2]);
        to.set(x + bone.to[0], bone.to[1], y + bone.to[2]);
        sphere(from, bone.radius, kind, color);
        sphere(to, bone.radius, kind, color);
        const length = from.distanceTo(to);
        if (length < 1e-6) continue;
        o.position.copy(from);
        o.quaternion.setFromUnitVectors(UP, to.sub(from).divideScalar(length));
        for (const [layer, r] of outlined(kind, bone.radius)) {
          o.scale.set(r, length, r);
          o.updateMatrix();
          put(`bone/${layer}`, layer === "outline" ? undefined : color);
        }
      }
      if (head) sphere(new Vector3(x + head[0], head[1], y + head[2]), HEAD_R, kind, color);
    };
    const poses = new Map(cameras.map((c) => [c.id, c.pose]));
    let discCount = 0;
    let ringCount = 0;
    const seen = new Set<string>();
    // 仍有目标在两次实测之间移动、在转向或锁定环未结束时继续逐帧绘制；全部到位后停绘，等下一次推送
    // 轨迹尚未跟上最新推送时同样续帧
    let pending = trailSource.current?.[0] !== targets || trailSource.current?.[1] !== behaviors;
    for (const target of list) {
      seen.add(target.key);
      const [x, y] = positionAt(target.trail, t);
      const desired = target.heading_deg === null ? undefined : (-target.heading_deg * Math.PI) / 180;
      const previous = headings.current.get(target.key);
      const angle =
        desired === undefined ? (previous ?? 0) : previous === undefined || !motion ? desired : turnToward(previous, desired, TURN_RATE * dt);
      headings.current.set(target.key, angle);
      pending ||= t < (target.trail.at(-1)?.[2] ?? 0) || (desired !== undefined && Math.abs(angle - desired) > 1e-3);
      const kind = target.uncertain ? "ghost" : "solid";
      const base = new Color(colorOf(target));
      const pose = poses.get(target.camera_id);
      const { object_class } = target;
      if (object_class === "person") {
        const f = pose && figure(target.keypoints, target.bbox, facing(pose, x, y));
        if (f) drawFigure(f, x, y, kind, base);
      } else {
        o.position.set(x, 0, y);
        o.rotation.set(0, angle, 0);
        o.scale.set(1, 1, 1);
        o.updateMatrix();
        put(`${object_class}/${kind}`, base);
        if (kind === "solid") put(`${object_class}/outline`);
      }
      o.position.set(x, 0, y);
      o.rotation.set(0, 0, 0);
      o.scale.set(target.uncertainty_m, 1, target.uncertainty_m);
      o.updateMatrix();
      if (discCount < CAPACITY) discs.current?.setMatrixAt(discCount++, o.matrix);
      const age = t - (target.trail[0]?.[2] ?? t);
      pending ||= age < LOCK_RING_MS;
      if (motion && age >= 0 && age < LOCK_RING_MS && ringCount < CAPACITY) {
        const radius = RING_RADIUS[target.object_class] * (0.4 + (1.2 * age) / LOCK_RING_MS);
        o.scale.set(radius, 1, radius);
        o.updateMatrix();
        rings.current?.setMatrixAt(ringCount++, o.matrix);
      }
    }
    for (const key of headings.current.keys()) if (!seen.has(key)) headings.current.delete(key);
    for (const { key } of layers) finish(meshes.current[key], counts[key] ?? 0);
    finish(discs.current, discCount);
    finish(rings.current, ringCount);
    if (motion && pending) invalidate();
  });

  return (
    <>
      {layers.map(({ key, geometry, capacity, kind, shaded }) => (
        <instancedMesh
          key={key}
          ref={(m) => {
            meshes.current[key] = m;
          }}
          args={[geometry, undefined, capacity]}
          castShadow={kind === "solid"}
          frustumCulled={false}
        >
          {kind === "solid" && <meshLambertMaterial vertexColors={shaded} />}
          {kind === "ghost" && <meshLambertMaterial vertexColors={shaded} transparent opacity={0.35} depthWrite={false} />}
          {kind === "outline" && (
            <meshBasicMaterial color={STATUS.neutral} transparent opacity={0.4} side={BackSide} depthWrite={false} />
          )}
        </instancedMesh>
      ))}
      <instancedMesh ref={discs} args={[DISC, undefined, CAPACITY]} frustumCulled={false}>
        <meshBasicMaterial color={STATUS.uncertain} transparent opacity={0.2} depthWrite={false} />
      </instancedMesh>
      <instancedMesh ref={rings} args={[RING, undefined, CAPACITY]} frustumCulled={false}>
        <meshBasicMaterial color={STATUS.neutral} transparent opacity={0.6} depthWrite={false} />
      </instancedMesh>
      {/* 轨迹：近 10 s 的实测位置连线（V-A5），合并为一组线段，绘制次数与目标数无关（V-P1） */}
      <lineSegments geometry={trails} frustumCulled={false}>
        <lineBasicMaterial vertexColors />
      </lineSegments>
    </>
  );
}

/**
 * 本帧写入了 count 个实例：只绘制并上传这些实例（实例移动、增减都在此生效；不做视锥剔除）。
 * 没有目标的图层隐藏，不参与绘制与阴影；只上传用到的部分，免得每帧上传全部容量
 */
function finish(mesh: InstancedMesh | null | undefined, written: number) {
  if (!mesh) return;
  const count = Math.min(written, mesh.instanceMatrix.count); // 超出容量的目标不绘制，不能让整层消失
  mesh.count = count;
  mesh.visible = count > 0;
  if (count === 0) return;
  for (const [attribute, size] of [
    [mesh.instanceMatrix, 16],
    [mesh.instanceColor, 3],
  ] as const) {
    if (!attribute) continue;
    attribute.clearUpdateRanges();
    attribute.addUpdateRange(0, count * size);
    attribute.needsUpdate = true;
  }
}

/** 把各目标近 10 s 的实测位置连线写入预分配缓冲区，只上传写入的部分；超出容量的部分不画 */
function writeTrails(geometry: BufferGeometry, list: Visible[]) {
  const position = geometry.getAttribute("position") as BufferAttribute;
  const color = geometry.getAttribute("color") as BufferAttribute;
  let v = 0;
  for (const target of list) {
    const { r, g, b } = new Color(target.alert ? STATUS.physical : STATUS.neutral);
    for (let i = 1; i < target.trail.length && v + 2 <= TRAIL_VERTICES; i += 1) {
      const prev = target.trail[i - 1];
      const cur = target.trail[i];
      if (!prev || !cur) continue;
      position.setXYZ(v, prev[0], 0.03, prev[1]);
      color.setXYZ(v++, r, g, b);
      position.setXYZ(v, cur[0], 0.03, cur[1]);
      color.setXYZ(v++, r, g, b);
    }
  }
  geometry.setDrawRange(0, v);
  for (const attribute of [position, color]) {
    attribute.clearUpdateRanges();
    attribute.addUpdateRange(0, v * 3);
    attribute.needsUpdate = true;
  }
}
