import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import {
  BackSide,
  Box3,
  type BufferGeometry,
  type Camera as ViewCamera,
  CircleGeometry,
  Color,
  CylinderGeometry,
  type InstancedMesh,
  Object3D,
  RingGeometry,
  SphereGeometry,
  Vector3,
} from "three";
import { type TargetClass, useLive } from "../store/live";
import { useSelection } from "../store/selection";
import { useMotion } from "./DeviceMarkers";
import { type Camera, STATUS } from "./devices";
import { facing, type Figure, figure, HEAD_R } from "./pose";
import { marker } from "./TargetMarker";
import { ACCENT, LOCK_RING_MS, positionAt, RENDER_DELAY_MS, turnToward, type Visible, visibleTargets } from "./targets";
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
/** 轨迹虚线点（§5.1 L5）：沿近 10 s 的实测轨迹每 0.4 m 一点，贴地；容量按每个目标 40 点 */
const DOT_SPACING_M = 0.4;
const DOT_CAPACITY = CAPACITY * 40;
const DOT = new CircleGeometry(0.07, 12).rotateX(-Math.PI / 2);
/** 括框在模型投影范围外留出的像素 */
const MARKER_PAD_PX = 6;
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
  // 轨迹点写入预分配的实例：推送频繁时不重建几何体，也不触发 React 重渲染
  const dots = useRef<InstancedMesh>(null);
  const trailSource = useRef<readonly [object, object] | null>(null);
  const trailBuilt = useRef(0);
  const motion = useMotion();
  const invalidate = useThree((s) => s.invalidate);
  // 新推送到达时请求一帧；逐帧插值由 useFrame 自行续帧
  useEffect(() => useLive.subscribe(() => invalidate()), [invalidate]);
  useEffect(() => useSelection.subscribe(() => invalidate()), [invalidate]);
  useEffect(() => invalidate(), [motion, cameras, invalidate]);

  useFrame(({ camera, size }) => {
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
      writeDots(dots.current, list);
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
    /** 人形：推测的部位与高误差目标一样半透明（D-056、V-U1） */
    const drawFigure = ({ bones, head }: Figure, x: number, y: number, uncertain: boolean, color: Color) => {
      const from = new Vector3();
      const to = new Vector3();
      for (const bone of bones) {
        const kind = uncertain || bone.inferred ? "ghost" : "solid";
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
      const at = new Vector3(x + head.at[0], head.at[1], y + head.at[2]);
      sphere(at, HEAD_R, uncertain || head.inferred ? "ghost" : "solid", color);
    };
    const poses = new Map(cameras.map((c) => [c.id, c.pose]));
    const selected = useSelection.getState().targetKey;
    let bounds: Box3 | null = null;
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
        if (f) drawFigure(f, x, y, target.uncertain, base);
        if (f && target.key === selected) bounds = figureBounds(f, x, y);
      } else {
        o.position.set(x, 0, y);
        o.rotation.set(0, angle, 0);
        o.scale.set(1, 1, 1);
        o.updateMatrix();
        put(`${object_class}/${kind}`, base);
        if (kind === "solid") put(`${object_class}/outline`);
        if (target.key === selected) bounds = vehicles[object_class].geometry.boundingBox?.clone().applyMatrix4(o.matrix) ?? null;
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
    placeMarker(bounds, camera, size);
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
      <instancedMesh ref={dots} args={[DOT, undefined, DOT_CAPACITY]} frustumCulled={false}>
        <meshBasicMaterial color={ACCENT} depthWrite={false} />
      </instancedMesh>
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

/** 把各目标近 10 s 的实测轨迹按 0.4 m 间隔写成虚线点（V-A5），合并为一次绘制、与目标数无关（V-P1）；超出容量的不画 */
function writeDots(mesh: InstancedMesh | null, list: Visible[]) {
  if (!mesh) return;
  const o = new Object3D();
  let n = 0;
  for (const { trail } of list) {
    let d = 0; // 下一个点距当前段起点的距离，跨段延续，点距均匀
    for (let i = 1; i < trail.length; i += 1) {
      const [a, b] = [trail[i - 1], trail[i]];
      if (!a || !b) continue;
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      for (; d < length; d += DOT_SPACING_M) {
        if (n >= DOT_CAPACITY) continue;
        const k = d / length;
        o.position.set(a[0] + (b[0] - a[0]) * k, 0.06, a[1] + (b[1] - a[1]) * k);
        o.updateMatrix();
        mesh.setMatrixAt(n++, o.matrix);
      }
      d -= length;
    }
  }
  finish(mesh, n);
}

/** 人形的包围盒：骨段两端与头顶 */
function figureBounds({ bones, head }: Figure, x: number, y: number): Box3 {
  const box = new Box3();
  for (const { from, to } of bones) {
    box.expandByPoint(new Vector3(x + from[0], from[1], y + from[2]));
    box.expandByPoint(new Vector3(x + to[0], to[1], y + to[2]));
  }
  box.expandByPoint(new Vector3(x + head.at[0], head.at[1] + HEAD_R, y + head.at[2]));
  return box;
}

/** 选中目标的包围盒投影到屏幕，写入括框的位置与尺寸；选中目标不在场景中时隐藏（§5.1 L5） */
function placeMarker(box: Box3 | null, camera: ViewCamera, size: { width: number; height: number }) {
  const el = marker.el;
  if (!el) return;
  el.hidden = box === null || box.isEmpty();
  if (el.hidden || !box) return;
  const xs: number[] = [];
  const ys: number[] = [];
  const v = new Vector3();
  for (let i = 0; i < 8; i += 1) {
    v.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).project(camera);
    xs.push(((v.x + 1) / 2) * size.width);
    ys.push(((1 - v.y) / 2) * size.height);
  }
  const [left, top] = [Math.min(...xs) - MARKER_PAD_PX, Math.min(...ys) - MARKER_PAD_PX];
  el.style.transform = `translate(${left}px, ${top}px)`;
  el.style.setProperty("--w", `${Math.max(...xs) + MARKER_PAD_PX - left}px`);
  el.style.setProperty("--h", `${Math.max(...ys) + MARKER_PAD_PX - top}px`);
}
