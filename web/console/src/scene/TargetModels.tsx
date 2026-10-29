import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import {
  type BufferGeometry,
  CapsuleGeometry,
  CircleGeometry,
  Color,
  CylinderGeometry,
  type InstancedMesh,
  type LineSegments,
  Object3D,
  RingGeometry,
  SphereGeometry,
  TorusGeometry,
} from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { type TargetClass, useLive } from "../store/live";
import { useMotion } from "./DeviceMarkers";
import { type Camera, STATUS } from "./devices";
import { LOCK_RING_MS, positionAt, RENDER_DELAY_MS, turnToward, type Visible, visibleTargets } from "./targets";

/** 每个图层的实例上限：C-FE-04 的 200 个目标，固定容量免得目标数变化时重建网格 */
const CAPACITY = 256;
/** 转向角速度上限（弧度每秒）：车辆掉头约 1 s 完成，不瞬间翻转 */
const TURN_RATE = 3;

/** 模型部件：几何体 + 明度系数（车身 1、车窗 0.55、轮胎 0.3），单色按明度区分部件，不引入新色相（UP-2） */
type Part = { geometry: BufferGeometry; shade: number };

/** 圆角长方体部件：长（沿行进方向 +x）、高、宽，中心位于 (dx, y, 0) */
const box = (length: number, height: number, width: number, radius: number, dx: number, y: number, shade = 1): Part => ({
  geometry: new RoundedBoxGeometry(length, height, width, 2, radius).translate(dx, y, 0),
  shade,
});

/** 车轮：轮轴沿宽度方向；axles 为各轴的前后位置，track 为左右轮距，ring 为两轮车的细轮圈 */
function wheels(radius: number, width: number, axles: number[], track: number, ring = false): Part {
  const sides = track === 0 ? [0] : [-track / 2, track / 2];
  const parts = axles.flatMap((dx) =>
    sides.map((dz) =>
      (ring ? new TorusGeometry(radius, width / 2, 8, 24) : new CylinderGeometry(radius, radius, width, 20).rotateX(Math.PI / 2)).translate(
        dx,
        radius,
        dz,
      ),
    ),
  );
  return { geometry: mergeGeometries(parts), shade: 0.3 };
}

/**
 * 目标模型（§5.1 L4，程序化生成的低多边形，借鉴车机 SR 的单色简化外形）：局部坐标 +x 为行进方向，底面落在地面。
 * 尺寸取常见车型：轿车 4.5 m、货车 7 m、公交 11 m；车窗与轮胎以明度区分，便于一眼认出车型与车头方向。
 */
const MODELS: Record<TargetClass, Part[]> = {
  person: [
    { geometry: new CapsuleGeometry(0.2, 0.95, 2, 8).translate(0, 0.68, 0), shade: 1 },
    { geometry: new SphereGeometry(0.15, 12, 8).translate(0, 1.5, 0), shade: 1 },
  ],
  bicycle: [box(1.05, 0.07, 0.06, 0.03, 0, 0.72), box(0.1, 0.42, 0.05, 0.02, 0.15, 0.55), wheels(0.33, 0.05, [-0.52, 0.52], 0, true)],
  motorcycle: [box(1.35, 0.42, 0.34, 0.12, -0.05, 0.72), box(0.55, 0.12, 0.3, 0.05, -0.3, 0.98, 0.55), wheels(0.32, 0.13, [-0.72, 0.72], 0, true)],
  car: [box(4.5, 0.62, 1.8, 0.14, 0, 0.6), box(2.4, 0.5, 1.6, 0.14, -0.25, 1.15, 0.55), wheels(0.34, 0.24, [-1.45, 1.45], 1.62)],
  bus: [box(11, 2.6, 2.5, 0.18, 0, 1.7), box(10.5, 0.85, 2.54, 0.06, 0, 2.25, 0.55), wheels(0.5, 0.32, [-3.8, 3.4], 2.2)],
  truck: [
    box(2.0, 2.1, 2.3, 0.14, 2.45, 1.4),
    box(0.25, 0.8, 2.1, 0.04, 3.4, 1.85, 0.55),
    box(5.0, 2.6, 2.4, 0.06, -1.15, 1.75),
    wheels(0.5, 0.3, [-3.0, -1.8, 2.4], 2.1),
  ],
};
const CLASSES = Object.keys(MODELS) as TargetClass[];
/** 不确定圆：单位半径，按 uncertainty_m 缩放（V-U1） */
const DISC = new CircleGeometry(1, 32).rotateX(-Math.PI / 2).translate(0, 0.02, 0);
/** 锁定环：新目标出现时由 0.4 扩散到 1.6 倍目标尺度（§5.1 L4） */
const RING = new RingGeometry(0.85, 1, 40).rotateX(-Math.PI / 2).translate(0, 0.04, 0);
/** 锁定环的基准半径：人员 0.6 m，车辆按车长 */
const RING_RADIUS: Record<TargetClass, number> = { person: 0.6, bicycle: 1.1, motorcycle: 1.2, car: 2.6, bus: 6, truck: 4 };

const colorOf = (t: Visible) => (t.alert ? STATUS.physical : STATUS.neutral);

/**
 * 检出目标：人员与车辆的 3D 模型、不确定圆、锁定环与轨迹（§5.1 L4、L5；V-U1；FR-102）。
 * 模型每帧按渲染时间轴（落后最新实测 200 ms）在相邻两次实测之间插值，并沿运动方向转向；不外推。
 * 只在仍有目标移动、转向或锁定环未结束时逐帧重绘；断线或降低动效时停在最新实测位置（V-U3、V-A4）。
 */
export function TargetModels({ cameras }: { cameras: Camera[] }) {
  const solid = useRef<Record<string, InstancedMesh | null>>({});
  const ghost = useRef<Record<string, InstancedMesh | null>>({});
  const discs = useRef<InstancedMesh>(null);
  const rings = useRef<InstancedMesh>(null);
  const headings = useRef(new Map<string, number>());
  const last = useRef(0);
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
    const o = new Object3D();
    const counts: Record<string, number> = {};
    let discCount = 0;
    let ringCount = 0;
    const seen = new Set<string>();
    // 仍有目标在两次实测之间移动、在转向或锁定环未结束时继续逐帧绘制；全部到位后停绘，等下一次推送
    let pending = false;
    for (const target of list) {
      seen.add(target.key);
      const [x, y] = positionAt(target.trail, t);
      const desired = target.heading_deg === null ? undefined : (-target.heading_deg * Math.PI) / 180;
      const previous = headings.current.get(target.key);
      const angle =
        desired === undefined ? (previous ?? 0) : previous === undefined || !motion ? desired : turnToward(previous, desired, TURN_RATE * dt);
      headings.current.set(target.key, angle);
      pending ||= t < (target.trail.at(-1)?.[2] ?? 0) || (desired !== undefined && Math.abs(angle - desired) > 1e-3);
      o.position.set(x, 0, y);
      o.rotation.set(0, angle, 0);
      o.scale.set(1, 1, 1);
      o.updateMatrix();
      const layer = `${target.object_class}/${target.uncertain ? "ghost" : "solid"}`;
      const i = counts[layer] ?? 0;
      counts[layer] = i + 1;
      const base = new Color(colorOf(target));
      const meshes = target.uncertain ? ghost.current : solid.current;
      MODELS[target.object_class].forEach(({ shade }, p) => {
        const mesh = meshes[`${target.object_class}/${p}`];
        if (!mesh || i >= CAPACITY) return;
        mesh.setMatrixAt(i, o.matrix);
        mesh.setColorAt(i, base.clone().multiplyScalar(shade));
      });
      o.scale.set(target.uncertainty_m, 1, target.uncertainty_m);
      o.updateMatrix();
      discs.current?.setMatrixAt(discCount++, o.matrix);
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
    for (const cls of CLASSES)
      for (const [kind, meshes] of [
        ["solid", solid.current],
        ["ghost", ghost.current],
      ] as const)
        MODELS[cls].forEach((_, p) => finish(meshes[`${cls}/${p}`], counts[`${cls}/${kind}`] ?? 0));
    finish(discs.current, discCount);
    finish(rings.current, ringCount);
    if (motion && pending) invalidate();
  });

  return (
    <>
      {CLASSES.flatMap((cls) =>
        MODELS[cls].flatMap(({ geometry }, p) => [
          <instancedMesh
            key={`${cls}/${p}/solid`}
            ref={(m) => {
              solid.current[`${cls}/${p}`] = m;
            }}
            args={[geometry, undefined, CAPACITY]}
            castShadow
            frustumCulled={false}
          >
            <meshLambertMaterial />
          </instancedMesh>,
          // 高误差：模型半透明、不投影（V-U1）
          <instancedMesh
            key={`${cls}/${p}/ghost`}
            ref={(m) => {
              ghost.current[`${cls}/${p}`] = m;
            }}
            args={[geometry, undefined, CAPACITY]}
            frustumCulled={false}
          >
            <meshLambertMaterial transparent opacity={0.35} depthWrite={false} />
          </instancedMesh>,
        ]),
      )}
      <instancedMesh ref={discs} args={[DISC, undefined, CAPACITY]} frustumCulled={false}>
        <meshBasicMaterial color={STATUS.uncertain} transparent opacity={0.2} depthWrite={false} />
      </instancedMesh>
      <instancedMesh ref={rings} args={[RING, undefined, CAPACITY]} frustumCulled={false}>
        <meshBasicMaterial color={STATUS.neutral} transparent opacity={0.6} depthWrite={false} />
      </instancedMesh>
      <Trails cameras={cameras} />
    </>
  );
}

/**
 * 本帧写入了 count 个实例：只绘制并上传这些实例（实例移动、增减都在此生效；不做视锥剔除）。
 * 没有目标的图层隐藏，不参与绘制与阴影；只上传用到的部分，免得每帧上传全部容量
 */
function finish(mesh: InstancedMesh | null | undefined, count: number) {
  if (!mesh) return;
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

/** 轨迹：近 10 s 的实测位置连线（V-A5），合并为一组线段，绘制次数与目标数无关（V-P1） */
function Trails({ cameras }: { cameras: Camera[] }) {
  const targets = useLive((s) => s.targets);
  const behaviors = useLive((s) => s.behaviors);
  const list = useMemo(() => visibleTargets(targets, cameras, behaviors), [targets, cameras, behaviors]);
  const ref = useRef<LineSegments>(null);
  const [positions, colors] = useMemo(() => {
    const p: number[] = [];
    const c: number[] = [];
    for (const target of list) {
      const { r, g, b } = new Color(colorOf(target));
      target.trail.forEach(([x, y], i) => {
        const prev = target.trail[i - 1];
        if (!prev) return;
        p.push(prev[0], 0.03, prev[1], x, 0.03, y);
        c.push(r, g, b, r, g, b);
      });
    }
    return [new Float32Array(p), new Float32Array(c)];
  }, [list]);
  useLayoutEffect(() => ref.current?.geometry.computeBoundingSphere(), [positions]);
  if (positions.length === 0) return null;
  return (
    // 顶点数变化时重建几何体；随目标移动，不做视锥剔除
    <lineSegments ref={ref} key={positions.length} frustumCulled={false}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
        <bufferAttribute attach="attributes-color" args={[colors, 3]} />
      </bufferGeometry>
      <lineBasicMaterial vertexColors />
    </lineSegments>
  );
}
