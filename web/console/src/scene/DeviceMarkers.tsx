import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import {
  BoxGeometry,
  BufferGeometry,
  CylinderGeometry,
  DoubleSide,
  EdgesGeometry,
  Float32BufferAttribute,
  type LineBasicMaterial,
  type LineSegments,
  type MeshBasicMaterial,
} from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { useConnection } from "../store/connection";
import { useShallow } from "zustand/react/shallow";
import { useLive } from "../store/live";
import { useTheme } from "../theme/store";
import { useViewpointCamera } from "./camera";
import { BEAM, BODY, type Camera, deviceLook, type Look, POLE_COLOR } from "./devices";
import { type Instance, Instanced } from "./Instanced";
import { coneOpacity, detectingByCamera } from "./targets";

/**
 * 摄像头机头：圆角机身 + 镜头，朝 +x、略向下俯（§5.1 L2 圆角低多边形，程序化生成）。
 * 按图标放大约 1.5 倍，总览下仍可辨认。
 */
function cameraHead(): BufferGeometry {
  const body = new RoundedBoxGeometry(0.84, 0.36, 0.39, 2, 0.08);
  const lens = new CylinderGeometry(0.13, 0.13, 0.09, 16).rotateZ(Math.PI / 2).translate(0.45, 0, 0);
  return mergeGeometries([body, lens.toNonIndexed()]).rotateZ(-Math.PI / 9).translate(0.27, 0, 0);
}
const HEAD = cameraHead();
/**
 * 轮廓：比机身大一圈的长方体棱线，不填充（处置中）或与机身同色（未标定）时仍清晰可见。
 * 圆角机身的相邻面夹角过小，取不到棱线，故另以长方体生成。
 */
function headOutline(): BufferGeometry {
  return new EdgesGeometry(new BoxGeometry(1.0, 0.46, 0.5)).rotateZ(-Math.PI / 9).translate(0.3, 0, 0);
}
const HEAD_OUTLINE = headOutline();
/** 立杆：单位高度，按安装高度沿 y 缩放 */
const POLE = new CylinderGeometry(0.04, 0.04, 1, 8).translate(0, 0.5, 0);

/** 平面角 yaw（由 +x 转向 +y）→ 场景绕竖轴的旋转：平面 (x, y) 对应场景 (x, 0, y) */
const turn = (yawDeg: number) => (-yawDeg * Math.PI) / 180;

/**
 * 设备模型 + 视场（§5.1 L2、L3；§5.2）。模型与立杆使用 InstancedMesh（V-P1），
 * 按不透明度分组：实心、离线半透明；"处置中"不填充，只画轮廓。
 */
export function DeviceMarkers({ cameras }: { cameras: Camera[] }) {
  // 视点一侧的摄像头挡在视线上：不画它的模型与立杆，视场照常（V-I1）
  const viewing = useViewpointCamera();
  const placed = cameras.map((camera) => ({ camera, look: deviceLook(camera.state), shown: camera.id !== viewing }));
  // 每次推送只统计一次；计数不变时不重渲染
  const detecting = useLive(useShallow((s) => detectingByCamera(s.targets)));
  const solid = placed.filter(({ look, shown }) => shown && look.fill && look.opacity === 1);
  const faded = placed.filter(({ look, shown }) => shown && look.fill && look.opacity < 1);
  // 立杆随机身变色会使状态色块面积失真：立杆始终为浅灰（V-S1、D-111）
  const poles = placed.filter(({ shown }) => shown).map(({ camera: { pose } }): Instance => ({
    position: [pose.x, 0, pose.y],
    scale: [1, pose.height_m, 1],
    color: POLE_COLOR,
  }));
  return (
    <>
      <Instanced geometry={POLE} items={poles} />
      <Instanced geometry={HEAD} items={solid.map(head)} />
      <Instanced geometry={HEAD} items={faded.map(head)} opacity={0.5} />
      {placed.map(({ camera, look, shown }) => (
        <Extras key={camera.id} camera={camera} look={shown ? look : { ...look, outline: null }} detecting={detecting[camera.id] ?? 0} />
      ))}
    </>
  );
}

type Item = { camera: Camera; look: Look };

const head = ({ camera: { pose }, look }: Item): Instance => ({
  position: [pose.x, pose.height_m, pose.y],
  rotationY: turn(pose.yaw_deg),
  color: look.fill ?? BODY,
});

/** 单台设备的轮廓、轮廓环与视场 */
function Extras({ camera: { pose, severe }, look, detecting }: Item & { detecting: number }) {
  const outline = useRef<LineSegments>(null);
  useLayoutEffect(() => {
    outline.current?.computeLineDistances(); // 虚线材质需要逐段距离
  }, [look.outline]);
  return (
    <>
      {look.outline && (
        <lineSegments ref={outline} geometry={HEAD_OUTLINE} position={[pose.x, pose.height_m, pose.y]} rotation-y={turn(pose.yaw_deg)}>
          {look.outline.dashed ? (
            <lineDashedMaterial color={look.outline.color} dashSize={0.08} gapSize={0.06} />
          ) : (
            <lineBasicMaterial color={look.outline.color} />
          )}
        </lineSegments>
      )}
      {look.ring && (
        <mesh rotation-x={-Math.PI / 2} position={[pose.x, 0.03, pose.y]}>
          <ringGeometry args={[0.5, 0.62, 48]} />
          <meshBasicMaterial color={look.ring} side={DoubleSide} />
        </mesh>
      )}
      {look.cone && <Cone detecting={detecting} pose={pose} cone={look.cone} severe={severe} />}
    </>
  );
}

const REDUCE = "(prefers-reduced-motion: reduce)";
const onReduceChange = (notify: () => void) => {
  const query = matchMedia(REDUCE);
  query.addEventListener("change", notify);
  return () => query.removeEventListener("change", notify);
};

/** 动效是否允许：断线、降低动效开关或系统 prefers-reduced-motion 任一生效即停止，且随其变化（V-U3、V-A4） */
export function useMotion(): boolean {
  const live = useConnection((s) => s.open || s.connecting);
  const user = useTheme((s) => s.reducedMotion);
  const system = useSyncExternalStore(onReduceChange, () => matchMedia(REDUCE).matches);
  return live && !user && !system;
}

/** 视场锥体的取样段数：弧线平滑且顶点很少 */
const ARC_SEGMENTS = 32;

/**
 * 三维视场（ui.md §5.2、D-111）：从镜头到可视距离处地面的扇形光束。几何在世界坐标中生成：
 * faces 为两侧面与顶到弧的曲面，顶点透明度随距镜头的水平距离线性渐隐（镜头处 1、可视距离处 0）；
 * ground 为地面扇形，edges 为地面投影的轮廓（扇形两边与弧线）。
 */
export function coneGeometry(pose: Camera["pose"]): { faces: BufferGeometry; ground: BufferGeometry; edges: BufferGeometry } {
  const yaw = (pose.yaw_deg * Math.PI) / 180;
  const hfov = (pose.hfov_deg * Math.PI) / 180;
  type P = [number, number, number];
  const apex: P = [pose.x, pose.height_m, pose.y];
  const base: P = [pose.x, 0.015, pose.y];
  const arc = Array.from({ length: ARC_SEGMENTS + 1 }, (_, i): P => {
    const a = yaw - hfov / 2 + (hfov * i) / ARC_SEGMENTS;
    return [pose.x + pose.range_m * Math.cos(a), 0.015, pose.y + pose.range_m * Math.sin(a)];
  });
  const faces: number[] = [];
  const ground: number[] = [];
  const edges: number[] = [];
  arc.slice(1).forEach((next, i) => {
    const prev = arc[i] as P;
    faces.push(...apex, ...prev, ...next);
    ground.push(...base, ...prev, ...next);
    edges.push(...prev, ...next);
  });
  for (const end of [arc[0], arc.at(-1)] as P[]) {
    faces.push(...apex, ...base, ...end);
    edges.push(...base, ...end);
  }
  const geometry = (values: number[]) => new BufferGeometry().setAttribute("position", new Float32BufferAttribute(values, 3));
  const beam = geometry(faces);
  // 白色顶点色 + 透明度（RGBA）：材质颜色与之相乘，透明度随水平距离渐隐
  const alpha: number[] = [];
  for (let i = 0; i < faces.length; i += 3) {
    const d = Math.hypot((faces[i] ?? 0) - pose.x, (faces[i + 2] ?? 0) - pose.y);
    alpha.push(1, 1, 1, Math.max(0, 1 - d / pose.range_m));
  }
  beam.setAttribute("color", new Float32BufferAttribute(alpha, 4));
  return { faces: beam, ground: geometry(ground), edges: geometry(edges) };
}

/** 侧面（镜头处）、地面填充、地面轮廓相对视场不透明度的倍数：常态为 14%、6%、35%（ui.md §5.2） */
const LAYERS = { faces: 1, ground: 0.43, edges: 2.5 } as const;

/** 视场：常态在该摄像头有检出目标时提亮（§5.1 L3）；critical / high 网络攻击时 1 Hz 呼吸（V-A1） */
function Cone(props: { detecting: number; pose: Camera["pose"]; cone: NonNullable<Look["cone"]>; severe: boolean }) {
  const { detecting, pose, cone, severe } = props;
  const faces = useRef<MeshBasicMaterial>(null);
  const ground = useRef<MeshBasicMaterial>(null);
  const edges = useRef<LineBasicMaterial>(null);
  const invalidate = useThree((s) => s.invalidate);
  const opacity = cone.color === BEAM ? coneOpacity(cone.opacity, detecting) : cone.opacity;
  const breathing = useMotion() && cone.breathe && severe;
  const set = (value: number) => {
    if (faces.current) faces.current.opacity = value * LAYERS.faces;
    if (ground.current) ground.current.opacity = value * LAYERS.ground;
    if (edges.current) edges.current.opacity = Math.min(1, value * LAYERS.edges);
  };
  // 呼吸停止后回到静止的不透明度
  useEffect(() => {
    if (!breathing) set(opacity);
    invalidate();
  });
  useFrame(({ clock }) => {
    if (!breathing) return;
    set(opacity * (0.7 + 0.3 * Math.sin(2 * Math.PI * clock.elapsedTime)));
    invalidate();
  });
  const geometry = useMemo(() => coneGeometry(pose), [pose]);
  useEffect(() => () => Object.values(geometry).forEach((g) => g.dispose()), [geometry]);
  // 普通混合、不发光（D-111）；不写深度，不遮挡其后的目标
  const common = { color: cone.color, transparent: true, depthWrite: false } as const;
  return (
    <>
      <mesh geometry={geometry.faces}>
        <meshBasicMaterial ref={faces} {...common} vertexColors opacity={opacity * LAYERS.faces} side={DoubleSide} />
      </mesh>
      <mesh geometry={geometry.ground}>
        <meshBasicMaterial ref={ground} {...common} opacity={opacity * LAYERS.ground} side={DoubleSide} />
      </mesh>
      <lineSegments geometry={geometry.edges}>
        <lineBasicMaterial ref={edges} {...common} opacity={Math.min(1, opacity * LAYERS.edges)} />
      </lineSegments>
    </>
  );
}
