import { Html, OrbitControls, Outlines } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { type ComponentRef, type ReactNode, Suspense, useEffect, useMemo, useRef, useState } from "react";
import {
  BoxGeometry,
  BufferGeometry,
  ConeGeometry,
  DoubleSide,
  EdgesGeometry,
  Float32BufferAttribute,
  type Group,
  type Mesh,
  type MeshStandardMaterial,
  Plane,
  Quaternion,
  Vector3,
} from "three";
import { AssetModels } from "../../scene/AreaScene";
import type { Device, Site, Target } from "../../store/live";

type Pose = NonNullable<Device["camera"]>["pose"];
import { deviceTone, EXPLODE_MS, layoutAreas, type Placed, TONE_COLOR } from "./data";

/**
 * 态势大屏中央的 3D（移植自 MF-TurbineMonitor 的 useThree / useTurbine）：
 * - 原项目：风机白色外壳自上而下平面削切露出线框骨架与内部部件 → 这里各区域的半透明外壳自上而下削切，露出线框墙体与区域内的搭建物体；
 * - 原项目：设备拆解（线框削切 → 部件分离 → 显示标签）/ 组装（逆序）→ 这里"区域展开"：线框削切后区域散开、物体层与摄像头层分层抬起并显示摄像头名称；
 * - 原项目：悬停部件自发光、单击描边并在右侧显示部件详情 → 这里悬停摄像头自发光、单击描边，右上面板显示设备详情；
 * - 原项目：设备告警随机挑部件标红并转动镜头 → 这里只巡检真实处于告警的摄像头（没有告警时巡检全部摄像头，不标红），镜头飞向当前摄像头。
 * 外壳与线框的削切用 renderer.localClippingEnabled + 材质 clippingPlanes，与原项目相同。
 */

/** 墙体（线框与外壳）高度，单位米 */
const WALL_H = 3;
/** 开场削切时长（秒） */
const OPEN_S = 3.2;
/** 展开后物体层、摄像头层抬起的高度与区域散开的比例 */
const LIFT_ITEMS = 2.2;
const LIFT_CAMERAS = 4.6;
const SPREAD = 0.35;
/** 视场锥的显示长度上限（米）：可视距离很远时只画近处一段，不铺满整个大屏 */
const CONE_MAX_M = 10;

const SHELL = "#bcdcff";
const WIRE = "#2f9bff";
const FLOOR = "#0b3d73";
const GRID_COLOR = "#3aa0ff";

export interface SceneProps {
  site: Site;
  devices: Device[];
  targets: Record<string, Target>;
  exploded: boolean;
  /** 告警巡检的当前摄像头：镜头飞向它 */
  focusId: string | null;
  selectedId: string | null;
  /** 每次变化镜头回到总览 */
  homeToken: number;
  onPick: (id: string | null) => void;
  onReady: () => void;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/**
 * 每帧共享的动画进度：open 为开场削切 0→1，explode 为展开 0→1（前 40% 线框削切，后 60% 分层与散开）。
 * 两张削切平面法向朝下：保留 y ≤ constant 的部分，constant 下降即自上而下削去
 */
class Anim {
  open = 0;
  explode = 0;
  readonly shell = new Plane(new Vector3(0, -1, 0), WALL_H + 0.01);
  readonly wire = new Plane(new Vector3(0, -1, 0), WALL_H + 0.01);

  advance(dt: number, exploded: boolean) {
    const step = Math.min(dt, 0.1);
    this.open = clamp01(this.open + step / OPEN_S);
    const rate = step / (EXPLODE_MS / 1000);
    this.explode = exploded ? Math.min(1, this.explode + rate) : Math.max(0, this.explode - rate);
    this.shell.constant = (WALL_H + 0.01) * (1 - easeInOut(this.open));
    this.wire.constant = (WALL_H + 0.01) * (1 - clamp01(this.explode / 0.4));
  }

  /** 分层与散开的进度 */
  get layer() {
    return easeInOut(clamp01((this.explode - 0.4) / 0.6));
  }
}

/** 区域散开后的左上角位置：以整体中心为原点按比例外移 */
function areaOrigin(p: Placed, s: number): [number, number] {
  const [cx, cz] = [p.x + p.width / 2, p.z + p.depth / 2];
  return [p.x + cx * SPREAD * s, p.z + cz * SPREAD * s];
}

/** 摄像头在世界中的位置（区域内坐标 x、y → three 的 x、z） */
function cameraWorld(p: Placed, pose: Pose, s: number): Vector3 {
  const [ox, oz] = areaOrigin(p, s);
  return new Vector3(ox + pose.x, pose.height_m + LIFT_CAMERAS * s, oz + pose.y);
}

export default function ScreenScene(props: SceneProps) {
  const { site, devices, targets, exploded, focusId, selectedId, homeToken, onPick, onReady } = props;
  const { placed, width, depth } = useMemo(() => layoutAreas(site.areas), [site.areas]);
  const anim = useMemo(() => new Anim(), []);
  const radius = Math.max(width, depth, 14);
  const byArea = useMemo(() => {
    const map = new Map<string, Device[]>();
    for (const d of devices) {
      const area = d.camera?.area_id;
      if (area) map.set(area, [...(map.get(area) ?? []), d]);
    }
    return map;
  }, [devices]);
  const focus = useMemo(() => {
    const device = devices.find((d) => d.id === focusId);
    const p = device && placed.find((a) => a.id === device.camera?.area_id);
    return device?.camera && p ? { pose: device.camera.pose, placed: p } : null;
  }, [devices, focusId, placed]);
  return (
    <Canvas
      dpr={[1, 2]}
      gl={{ antialias: true, alpha: true }}
      camera={{
        fov: 45,
        near: 0.1,
        far: 2000,
        position: [0, radius * 2.4, radius * 2.6],
      }}
      onCreated={({ gl }) => {
        gl.localClippingEnabled = true;
        gl.setClearAlpha(0);
      }}
      onPointerMissed={() => onPick(null)}
    >
      <ambientLight intensity={1.1} />
      <hemisphereLight args={["#cfe6ff", "#06264d", 1.2]} />
      <directionalLight position={[radius, radius * 1.5, radius]} intensity={2.2} />
      <directionalLight position={[-radius, radius, -radius]} intensity={0.8} color="#7fb4ff" />
      <Driver anim={anim} exploded={exploded} />
      <Ready onReady={onReady} />
      {placed.map((p) => {
        const items = site.areas.find((a) => a.id === p.id)?.items ?? [];
        return (
          <AreaBlock key={p.id} placed={p} items={items} anim={anim}>
            {(byArea.get(p.id) ?? []).flatMap((d) =>
              d.camera
                ? [
                    <CameraNode
                      key={d.id}
                      device={d}
                      pose={d.camera.pose}
                      anim={anim}
                      exploded={exploded}
                      selected={d.id === selectedId}
                      focused={d.id === focusId}
                      onPick={onPick}
                    />,
                  ]
                : [],
            )}
            <Targets targets={targets} devices={byArea.get(p.id) ?? []} />
          </AreaBlock>
        );
      })}
      <Rig anim={anim} radius={radius} exploded={exploded} homeToken={homeToken} focus={focus} />
    </Canvas>
  );
}

/** 推进开场与展开的进度 */
function Driver({ anim, exploded }: { anim: Anim; exploded: boolean }) {
  useFrame((_, dt) => anim.advance(dt, exploded));
  return null;
}

function Ready({ onReady }: { onReady: () => void }) {
  const done = useRef(false);
  useFrame(() => {
    if (done.current) return;
    done.current = true;
    onReady();
  });
  return null;
}

/** 镜头：开场从高处飞到总览；巡检时飞向摄像头；展开时抬高；用户拖动即停止飞行（与原项目的 TWEEN 镜头过渡对应） */
function Rig(props: { anim: Anim; radius: number; exploded: boolean; homeToken: number; focus: { pose: Pose; placed: Placed } | null }) {
  const { anim, radius, exploded, homeToken, focus } = props;
  const controls = useRef<ComponentRef<typeof OrbitControls>>(null);
  const goal = useRef<(() => { pos: Vector3; target: Vector3 }) | null>(null);
  const home = useMemo(
    () => (raised: boolean) => () => ({
      pos: new Vector3(0, radius * (raised ? 0.8 : 0.55), radius * (raised ? 0.75 : 0.8)),
      target: new Vector3(0, raised ? LIFT_CAMERAS / 2 : 0, 0),
    }),
    [radius],
  );
  useEffect(() => {
    goal.current = home(exploded);
  }, [home, exploded, homeToken]);
  useEffect(() => {
    if (!focus) return;
    // 从飞行开始时的视线方向靠近，停在目标斜上方
    const c = controls.current;
    const dir = c ? c.object.position.clone().sub(c.target).setY(0).normalize() : new Vector3(0, 0, 1);
    if (dir.lengthSq() === 0) dir.set(0, 0, 1);
    const offset = dir.multiplyScalar(14).add(new Vector3(0, 11, 0));
    goal.current = () => {
      const target = cameraWorld(focus.placed, focus.pose, anim.layer);
      return { target, pos: target.clone().add(offset) };
    };
  }, [focus, anim]);
  useEffect(() => {
    const c = controls.current;
    if (!c) return;
    const stop = () => (goal.current = null);
    c.addEventListener("start", stop);
    return () => c.removeEventListener("start", stop);
  }, []);
  useFrame((state, dt) => {
    const c = controls.current;
    const get = goal.current;
    if (!c || !get) return;
    const { pos, target } = get();
    const k = 1 - Math.exp(-Math.min(dt, 0.1) * 2.6);
    state.camera.position.lerp(pos, k);
    c.target.lerp(target, k);
    c.update();
    if (state.camera.position.distanceTo(pos) < 0.02 && c.target.distanceTo(target) < 0.02) goal.current = null;
  });
  return (
    <OrbitControls
      ref={controls}
      makeDefault
      enableDamping
      dampingFactor={0.1}
      minPolarAngle={(15 * Math.PI) / 180}
      maxPolarAngle={(82 * Math.PI) / 180}
      minDistance={3}
      maxDistance={radius * 4}
    />
  );
}

/** 地面网格线（每 step 米）与墙面线框（竖线每 2 米、横线每 1 米），合并为一组线段 */
function gridGeometry(w: number, d: number, step: number) {
  const pts: number[] = [];
  for (let x = 0; x <= w + 1e-6; x += step) pts.push(x, 0.01, 0, x, 0.01, d);
  for (let z = 0; z <= d + 1e-6; z += step) pts.push(0, 0.01, z, w, 0.01, z);
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(pts, 3));
  return g;
}

function wallGeometry(w: number, d: number) {
  const pts: number[] = [];
  const walls: [number, number, number, number][] = [
    [0, 0, w, 0],
    [w, 0, w, d],
    [w, d, 0, d],
    [0, d, 0, 0],
  ];
  for (const [x0, z0, x1, z1] of walls) {
    const len = Math.hypot(x1 - x0, z1 - z0);
    const n = Math.max(1, Math.round(len / 2));
    for (let i = 0; i <= n; i++) {
      const [x, z] = [x0 + ((x1 - x0) * i) / n, z0 + ((z1 - z0) * i) / n];
      pts.push(x, 0, z, x, WALL_H, z);
    }
    for (let y = 1; y <= WALL_H; y += 1) pts.push(x0, y, z0, x1, y, z1);
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(pts, 3));
  return g;
}

/** 一个区域：地面与网格、线框墙体、开场削切的外壳、搭建物体（展开时抬起）与区域名称 */
function AreaBlock(props: { placed: Placed; items: Site["areas"][number]["items"]; anim: Anim; children: ReactNode }) {
  const { placed, items, anim, children } = props;
  const { width: w, depth: d } = placed;
  const group = useRef<Group>(null);
  const itemLayer = useRef<Group>(null);
  const shell = useRef<Mesh>(null);
  const grid = useMemo(() => gridGeometry(w, d, Math.max(w, d) > 60 ? 2 : 1), [w, d]);
  const walls = useMemo(() => wallGeometry(w, d), [w, d]);
  const edges = useMemo(() => {
    const box = new BoxGeometry(w, WALL_H, d).translate(w / 2, WALL_H / 2, d / 2);
    const e = new EdgesGeometry(box);
    box.dispose();
    return e;
  }, [w, d]);
  useEffect(() => () => [grid, walls, edges].forEach((g) => g.dispose()), [grid, walls, edges]);
  useFrame(() => {
    const s = anim.layer;
    const [ox, oz] = areaOrigin(placed, s);
    group.current?.position.set(ox, 0, oz);
    itemLayer.current?.position.setY(LIFT_ITEMS * s);
    if (shell.current) shell.current.visible = anim.open < 1;
  });
  return (
    <group ref={group}>
      <mesh rotation-x={-Math.PI / 2} position={[w / 2, 0, d / 2]} raycast={() => undefined}>
        <planeGeometry args={[w, d]} />
        <meshBasicMaterial color={FLOOR} transparent opacity={0.45} depthWrite={false} />
      </mesh>
      <lineSegments geometry={grid} raycast={() => undefined}>
        <lineBasicMaterial color={GRID_COLOR} transparent opacity={0.16} depthWrite={false} />
      </lineSegments>
      <lineSegments geometry={walls} raycast={() => undefined}>
        <lineBasicMaterial color={WIRE} transparent opacity={0.5} clippingPlanes={[anim.wire]} depthWrite={false} />
      </lineSegments>
      <lineSegments geometry={edges} raycast={() => undefined}>
        <lineBasicMaterial color="#74f7fd" transparent opacity={0.9} clippingPlanes={[anim.wire]} />
      </lineSegments>
      <mesh ref={shell} position={[w / 2, WALL_H / 2, d / 2]} raycast={() => undefined}>
        <boxGeometry args={[w, WALL_H, d]} />
        <meshStandardMaterial
          color={SHELL}
          transparent
          opacity={0.55}
          side={DoubleSide}
          depthWrite={false}
          clippingPlanes={[anim.shell]}
          clipShadows
        />
      </mesh>
      <group ref={itemLayer}>
        <Suspense fallback={null}>{items.length > 0 && <AssetModels items={items} />}</Suspense>
      </group>
      <Html position={[w / 2, 0, d + 0.6]} center zIndexRange={[5, 0]} className="bs-area-label" style={{ pointerEvents: "none" }}>
        {placed.name}
      </Html>
      {children}
    </group>
  );
}

const UP = new Vector3(0, -1, 0);
const X = new Vector3(1, 0, 0);

/** 摄像头：立杆、机身（按状态着色，告警时呼吸发光）与视场锥；悬停自发光，选中描边，展开后显示名称 */
function CameraNode(props: {
  device: Device;
  pose: Pose;
  anim: Anim;
  exploded: boolean;
  selected: boolean;
  focused: boolean;
  onPick: (id: string) => void;
}) {
  const { device, pose, anim, exploded, selected, focused, onPick } = props;
  const tone = deviceTone(device.state);
  const color = tone === "ok" ? "#d8ecff" : TONE_COLOR[tone];
  const alerting = tone === "cyber" || tone === "physical";
  const [hover, setHover] = useState(false);
  const node = useRef<Group>(null);
  const pole = useRef<Mesh>(null);
  const body = useRef<Mesh>(null);
  const { quat, bodyQuat } = useMemo(() => {
    const [yaw, pitch] = [(pose.yaw_deg * Math.PI) / 180, (pose.pitch_deg * Math.PI) / 180];
    const dir = new Vector3(Math.cos(pitch) * Math.cos(yaw), Math.sin(pitch), Math.cos(pitch) * Math.sin(yaw)).normalize();
    return {
      quat: new Quaternion().setFromUnitVectors(UP, dir),
      bodyQuat: new Quaternion().setFromUnitVectors(X, dir),
    };
  }, [pose.yaw_deg, pose.pitch_deg]);
  const cone = useMemo(() => {
    const h = Math.min(pose.range_m, CONE_MAX_M);
    const r = h * Math.tan(((pose.hfov_deg / 2) * Math.PI) / 180);
    return new ConeGeometry(r, h, 32, 1, true).translate(0, -h / 2, 0);
  }, [pose.range_m, pose.hfov_deg]);
  useEffect(() => () => cone.dispose(), [cone]);
  const invalidate = useThree((s) => s.invalidate);
  useFrame((state) => {
    const lift = LIFT_CAMERAS * anim.layer;
    node.current?.position.set(pose.x, pose.height_m + lift, pose.y);
    if (pole.current) {
      const h = pose.height_m + lift;
      pole.current.scale.set(1, h, 1);
      pole.current.position.set(0, -h / 2, 0);
    }
    const material = body.current?.material as MeshStandardMaterial | undefined;
    if (material) {
      const pulse = alerting || focused ? 0.45 + 0.45 * Math.sin(state.clock.elapsedTime * 5) : 0;
      material.emissiveIntensity = hover ? 0.9 : pulse;
    }
  });
  useEffect(() => invalidate(), [hover, invalidate]);
  const handlers = {
    onClick: (e: { stopPropagation: () => void }) => {
      e.stopPropagation();
      onPick(device.id);
    },
    onPointerOver: (e: { stopPropagation: () => void }) => {
      e.stopPropagation();
      setHover(true);
      document.body.style.cursor = "pointer";
    },
    onPointerOut: () => {
      setHover(false);
      document.body.style.cursor = "";
    },
  };
  useEffect(() => () => void (document.body.style.cursor = ""), []);
  return (
    <group ref={node}>
      <mesh ref={pole} {...handlers}>
        <cylinderGeometry args={[0.05, 0.05, 1, 8]} />
        <meshStandardMaterial color="#8fb8e8" transparent opacity={0.8} />
      </mesh>
      <mesh ref={body} quaternion={bodyQuat} {...handlers}>
        <boxGeometry args={[0.6, 0.26, 0.26]} />
        <meshStandardMaterial color={color} emissive={alerting ? color : "#5bc7fa"} emissiveIntensity={0} />
        {selected && <Outlines thickness={0.06} color="#ffffff" />}
      </mesh>
      <mesh geometry={cone} quaternion={quat} raycast={() => undefined}>
        <meshBasicMaterial
          color={alerting ? color : "#5bc7fa"}
          transparent
          opacity={alerting ? 0.2 : 0.1}
          side={DoubleSide}
          depthWrite={false}
        />
      </mesh>
      <Html position={[0, 0.7, 0]} center zIndexRange={[6, 0]} style={{ pointerEvents: "none" }}>
        <div className={`bs-cam-label${exploded || selected || focused ? " show" : ""}${alerting ? " alert" : ""}`}>{device.name}</div>
      </Html>
    </group>
  );
}

/** 当前画面中的目标：人员为蓝点、车辆为紫点，贴地光圈 */
function Targets({ targets, devices }: { targets: Record<string, Target>; devices: Device[] }) {
  const ids = useMemo(() => new Set(devices.map((d) => d.id)), [devices]);
  const list = Object.entries(targets).filter(([, t]) => ids.has(t.camera_id));
  return list.map(([key, t]) => {
    const color = t.object_class === "person" ? "#7dd3fc" : "#c4b5fd";
    return (
      <group key={key} position={[t.x, 0, t.y]}>
        <mesh position={[0, 0.85, 0]} raycast={() => undefined}>
          <sphereGeometry args={[0.22, 16, 12]} />
          <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.6} />
        </mesh>
        <mesh rotation-x={-Math.PI / 2} position={[0, 0.02, 0]} raycast={() => undefined}>
          <ringGeometry args={[0.35, 0.5, 32]} />
          <meshBasicMaterial color={color} transparent opacity={0.6} depthWrite={false} />
        </mesh>
      </group>
    );
  });
}
