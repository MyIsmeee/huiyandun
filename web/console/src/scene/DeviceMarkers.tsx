import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import {
  BoxGeometry,
  type BufferGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  EdgesGeometry,
  type InstancedMesh,
  type LineSegments,
  type MeshBasicMaterial,
  Object3D,
} from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { useConnection } from "../store/connection";
import { prefersReducedMotion, useTheme } from "../theme/store";
import { type Camera, deviceLook, type Look, STATUS } from "./devices";

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
  const placed = cameras.map((camera) => ({ camera, look: deviceLook(camera.state) }));
  const solid = placed.filter(({ look }) => look.fill && look.opacity === 1);
  const faded = placed.filter(({ look }) => look.fill && look.opacity < 1);
  return (
    <>
      <Instances geometry={POLE} items={placed} opacity={1} pole />
      <Instances geometry={HEAD} items={solid} opacity={1} />
      <Instances geometry={HEAD} items={faded} opacity={0.5} />
      {placed.map(({ camera, look }) => (
        <Extras key={camera.id} camera={camera} look={look} />
      ))}
    </>
  );
}

type Item = { camera: Camera; look: Look };

function Instances({ geometry, items, opacity, pole }: { geometry: BufferGeometry; items: Item[]; opacity: number; pole?: boolean }) {
  const ref = useRef<InstancedMesh>(null);
  const invalidate = useThree((s) => s.invalidate);
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const o = new Object3D();
    items.forEach(({ camera: { pose }, look }, i) => {
      o.position.set(pose.x, pole ? 0 : pose.height_m, pose.y);
      o.rotation.set(0, turn(pose.yaw_deg), 0);
      o.scale.set(1, pole ? pose.height_m : 1, 1);
      o.updateMatrix();
      mesh.setMatrixAt(i, o.matrix);
      // 立杆随机身变色会使状态色块面积失真：立杆始终为中性色（V-S1）
      mesh.setColorAt(i, new Color(pole ? STATUS.neutral : (look.fill ?? STATUS.neutral)));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    invalidate();
  }, [items, pole, invalidate]);
  if (items.length === 0) return null;
  return (
    // 实例数变化时重建：InstancedMesh 的容量在创建时确定
    <instancedMesh key={items.length} ref={ref} args={[geometry, undefined, items.length]} castShadow>
      <meshLambertMaterial transparent={opacity < 1} opacity={opacity} depthWrite={opacity === 1} />
    </instancedMesh>
  );
}

/** 单台设备的轮廓、轮廓环与视场 */
function Extras({ camera: { pose }, look }: Item) {
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
      {look.cone && <Cone pose={pose} cone={look.cone} />}
    </>
  );
}

/** 视场：地面扇形，半径为视距、张角为水平视场角（§5.1 L3） */
function Cone({ pose, cone }: { pose: Camera["pose"]; cone: NonNullable<Look["cone"]> }) {
  const material = useRef<MeshBasicMaterial>(null);
  const invalidate = useThree((s) => s.invalidate);
  // 断线或降低动效时不呼吸（V-U3、V-A4）
  const live = useConnection((s) => s.open || s.connecting);
  useTheme((s) => s.reducedMotion);
  const breathing = cone.breathe && live && !prefersReducedMotion();
  useEffect(() => {
    if (material.current) material.current.opacity = cone.opacity;
    invalidate();
  }, [breathing, cone.opacity, invalidate]);
  useFrame(({ clock }) => {
    if (!breathing || !material.current) return;
    // 1 Hz 呼吸，不超过 2 Hz（V-A1）
    material.current.opacity = cone.opacity * (0.7 + 0.3 * Math.sin(2 * Math.PI * clock.elapsedTime));
    invalidate();
  });
  const hfov = (pose.hfov_deg * Math.PI) / 180;
  const yaw = (pose.yaw_deg * Math.PI) / 180;
  const sector = useMemo(() => [pose.range_m, 48, yaw - hfov / 2, hfov] as const, [pose.range_m, yaw, hfov]);
  return (
    // 绕 x 轴转 90°：平面 (x, y) 落到地面 (x, 0, y)，扇形角度与 yaw 同向
    <mesh rotation-x={Math.PI / 2} position={[pose.x, 0.015, pose.y]}>
      <circleGeometry args={sector} />
      <meshBasicMaterial ref={material} color={cone.color} transparent opacity={cone.opacity} depthWrite={false} side={DoubleSide} />
    </mesh>
  );
}
