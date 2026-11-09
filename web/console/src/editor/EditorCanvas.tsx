import { CameraControls, CameraControlsImpl } from "@react-three/drei";
import { Canvas, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import { Box3, BufferGeometry, DoubleSide, Float32BufferAttribute, Sphere, Vector3 } from "three";
import type { SceneArea } from "../lib/api";
import { AreaScene, AssetModels } from "../scene/AreaScene";
import { MATERIALS, type SceneItem, useCatalog } from "../scene/assets";
import { DeviceMarkers } from "../scene/DeviceMarkers";
import type { Camera } from "../scene/devices";
import { bounds, GROUND_M } from "../scene/layout";
import { BACKGROUND, FirstFrame, Lights, ShadowCatcher } from "../scene/Scene3D";
import { ACCENT } from "../scene/targets";
import { placeItem, useDraft } from "./draft";
import { overlaps, snap, span } from "./placement";
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
  /** 草稿中的物体（未保存的修改也在内） */
  items: SceneItem[];
  cameras: Camera[];
  /** 画布就绪后提供相机操作，卸载时传 null */
  onView: (view: EditorView | null) => void;
  onReady: () => void;
}) {
  const { area, items, cameras, onView, onReady } = props;
  const box = useMemo(() => bounds(area), [area]);
  return (
    <Canvas flat shadows="soft" frameloop="demand" camera={{ fov: 35, near: 0.5, far: GROUND_M }}>
      <color attach="background" args={[BACKGROUND]} />
      <FirstFrame onReady={onReady} />
      <Lights area={box} />
      <ShadowCatcher area={box} />
      <AreaScene area={box} items={items} />
      <GridLines width={area.width_m} depth={area.depth_m} />
      <DeviceMarkers cameras={cameras} />
      <Placement size={[area.width_m, area.depth_m]} items={items} />
      <Controls width={area.width_m} depth={area.depth_m} onView={onView} />
      {import.meta.env.MODE === "e2e" && <GroundProbe />}
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

/** 预览占地的颜色：可放置为强调色（设计 150 E-2），与已有物体重叠时转灰 */
const BLOCKED = "#94A3B8";

/**
 * 放置（设计 150 E-2）：选中模型后，指针所在处显示吸附网格的半透明预览与占地；单击放下，可连续放置。
 * 与同层已有物体重叠时占地转灰，单击不放置
 */
function Placement({ size, items }: { size: [number, number]; items: SceneItem[] }) {
  const catalog = useCatalog();
  const asset = catalog.get(useDraft((s) => s.tool) ?? "");
  const [point, setPoint] = useState<[number, number] | null>(null);
  if (!asset) return null;
  const item = point && snap(asset, 0, point, size);
  const blocked = item ? overlaps(item, items, catalog) : false;
  const [sx, sy] = span(asset, 0);
  const center: [number, number] | null = item && (asset.line ? [item.x + sx / 2, item.y] : [item.x, item.y]);
  return (
    <>
      {/* 接收指针的地面：完全透明，铺满区域 */}
      <mesh
        rotation-x={-Math.PI / 2}
        position={[size[0] / 2, 0, size[1] / 2]}
        onPointerMove={(e) => setPoint([e.point.x, e.point.z])}
        onPointerOut={() => setPoint(null)}
        onClick={(e) => {
          // 按单击处计算，不依赖上一次指针移动的预览：直接单击同样放在指针下
          const placed = snap(asset, 0, [e.point.x, e.point.z], size);
          if (e.button !== 0 || overlaps(placed, items, catalog)) return;
          e.stopPropagation();
          placeItem(placed);
        }}
      >
        <planeGeometry args={size} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} side={DoubleSide} />
      </mesh>
      {item && center && (
        <>
          <AssetModels items={[item]} ghost />
          <mesh rotation-x={-Math.PI / 2} position={[center[0], 0.01, center[1]]} raycast={() => undefined}>
            <planeGeometry args={[sx, sy]} />
            <meshBasicMaterial color={blocked ? BLOCKED : ACCENT} transparent opacity={0.3} depthWrite={false} />
          </mesh>
        </>
      )}
    </>
  );
}

/** 只在 e2e 构建中提供：区域地面点 (x, y) 在画布上的像素位置，用例据此在指定位置点击 */
function GroundProbe() {
  const { camera, size } = useThree();
  useEffect(() => {
    window.__hydEditorAt = (x, y) => {
      const p = new Vector3(x, 0, y).project(camera);
      return [((p.x + 1) / 2) * size.width, ((1 - p.y) / 2) * size.height];
    };
    return () => {
      delete window.__hydEditorAt;
    };
  }, [camera, size]);
  return null;
}

declare global {
  interface Window {
    /** e2e 构建专用（见 EditorCanvas） */
    __hydEditorAt?: (x: number, y: number) => [number, number];
  }
}
