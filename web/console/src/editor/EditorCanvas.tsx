import { CameraControls, CameraControlsImpl } from "@react-three/drei";
import { Canvas, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import { Box3, BufferGeometry, Float32BufferAttribute, Sphere, Vector3 } from "three";
import type { SceneArea } from "../lib/api";
import { AreaScene } from "../scene/AreaScene";
import { MATERIALS } from "../scene/assets";
import { DeviceMarkers } from "../scene/DeviceMarkers";
import type { Camera } from "../scene/devices";
import { bounds, GROUND_M } from "../scene/layout";
import { BACKGROUND, FirstFrame, Lights, ShadowCatcher } from "../scene/Scene3D";
import type { EditorView } from "./view";

/** 俯视 45°（设计 150 E-1），方位与态势页默认的东南机位一致：相机在 (+x, +z) 方向 */
const TILT = Math.PI / 4;
const AZIMUTH = Math.PI / 4;
/** 每次放大、缩小改变视距的倍数 */
const ZOOM_STEP = 0.7;
const MIN_DISTANCE_M = 4;
const { ACTION } = CameraControlsImpl;

/**
 * 场景页的 3D 编辑视图（设计 150 §6 E-1）：与态势页同一套场景、光照与设备外观，地面加 1 m 网格。
 * 右键拖动平移（沿地面）、中键拖动旋转、滚轮缩放；左键留给放置与选中。平移不超出区域
 */
export default function EditorCanvas(props: {
  area: SceneArea;
  cameras: Camera[];
  /** 画布就绪后提供相机操作，卸载时传 null */
  onView: (view: EditorView | null) => void;
  onReady: () => void;
}) {
  const { area, cameras, onView, onReady } = props;
  const box = useMemo(() => bounds(area), [area]);
  return (
    <Canvas flat shadows="soft" frameloop="demand" camera={{ fov: 35, near: 0.5, far: GROUND_M }}>
      <color attach="background" args={[BACKGROUND]} />
      <FirstFrame onReady={onReady} />
      <Lights area={box} />
      <ShadowCatcher area={box} />
      <AreaScene area={box} items={area.items} />
      <GridLines width={area.width_m} depth={area.depth_m} />
      <DeviceMarkers cameras={cameras} />
      <Controls width={area.width_m} depth={area.depth_m} onView={onView} />
    </Canvas>
  );
}

function Controls(props: { width: number; depth: number; onView: (view: EditorView | null) => void }) {
  const { width, depth, onView } = props;
  const ref = useRef<CameraControlsImpl>(null);
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => {
    const controls = ref.current;
    if (!controls) return;
    const sphere = new Sphere(new Vector3(width / 2, 0, depth / 2), Math.hypot(width, depth) / 2);
    const home = (animate: boolean) => {
      void controls.rotateTo(AZIMUTH, TILT, animate);
      void controls.fitToSphere(sphere, animate);
    };
    home(false);
    controls.maxDistance = controls.distance * 2;
    controls.setBoundary(new Box3(new Vector3(0, 0, 0), new Vector3(width, 0, depth)));
    // 按需渲染：页面上的控件改了相机后须请求一帧，相机控件随后在每帧更新中继续请求直到转场结束
    const then = (change: () => void) => {
      change();
      invalidate();
    };
    onView({
      zoom: (direction, animate) => then(() => void controls.dollyTo(controls.distance * (direction > 0 ? ZOOM_STEP : 1 / ZOOM_STEP), animate)),
      rotate: (animate) => then(() => void controls.rotate(Math.PI / 2, 0, animate)),
      home: (animate) => then(() => home(animate)),
    });
    return () => onView(null);
  }, [width, depth, onView, invalidate]);
  return (
    <CameraControls
      ref={ref}
      makeDefault
      minPolarAngle={TILT}
      maxPolarAngle={TILT}
      minDistance={MIN_DISTANCE_M}
      verticalDragToForward
      dollyToCursor
      mouseButtons={{ left: ACTION.NONE, middle: ACTION.ROTATE, right: ACTION.TRUCK, wheel: ACTION.DOLLY }}
    />
  );
}

/** 区域内的 1 m 网格（只在场景页出现，设计 150 §4）；略高于地面，不接收点选 */
function GridLines({ width, depth }: { width: number; depth: number }) {
  const geometry = useMemo(() => {
    const points: number[] = [];
    for (let x = 0; x <= width; x += 1) points.push(x, 0, 0, x, 0, depth);
    for (let z = 0; z <= depth; z += 1) points.push(0, 0, z, width, 0, z);
    return new BufferGeometry().setAttribute("position", new Float32BufferAttribute(points, 3));
  }, [width, depth]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return (
    <lineSegments geometry={geometry} position-y={0.002} raycast={() => undefined}>
      <lineBasicMaterial color={MATERIALS.roof} />
    </lineSegments>
  );
}
