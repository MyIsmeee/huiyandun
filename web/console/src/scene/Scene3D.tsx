import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { Object3D, type PerspectiveCamera } from "three";
import { DeviceMarkers } from "./DeviceMarkers";
import { TargetModels } from "./TargetModels";
import type { Camera } from "./devices";
import { AreaScene } from "./AreaScene";
import type { SceneItem } from "./assets";
import type { Area, SceneView } from "./layout";

/** 页面底色（ui.md §3），场景背景与远处渐隐取同色 */
export const BACKGROUND = "#F4F5F7";
/** 主光方向（ui.md §5.2）：方位 135°、仰角 55° */
const SUN_AZIMUTH = (135 * Math.PI) / 180;
const SUN_ELEVATION = (55 * Math.PI) / 180;
/** 阴影贴图边长：截图测试以软件渲染运行，减半（V-P2） */
const SHADOW_MAP = import.meta.env.MODE === "e2e" ? 1024 : 2048;
/** 渐隐的过渡距离，单位米 */
const FOG_M = 50;
/** 阴影承接面的不透明度（设计 150 §4）：只显示阴影，其余完全透明；浅色地面上约 25% 即清晰可见 */
const SHADOW_OPACITY = 0.25;
/** 阴影承接面与阴影相机在区域外多留的边距，单位米 */
const SHADOW_MARGIN_M = 4;

/**
 * 空间态势（D-120、D-111、设计 150 §9）：当前区域管理员搭建的场景与渐隐地面，叠加设备、视场与检出目标；
 * 只显示阴影的承接面让物体落地。
 * 固定的半球光 + 平行主光，投射软阴影，不随时间变化。按需渲染（frameloop="demand"）：无常驻动效（V-A3），
 * 只有对应真实告警的动效持续请求重绘。flat 关闭色调映射，色值与规范一致。
 */
export default function Scene3D(props: { area: Area; items: SceneItem[]; cameras: Camera[]; view: SceneView; onReady: () => void }) {
  const { area, items, cameras, view, onReady } = props;
  // 远处渐隐为底色：区域在取景中心周围时始终不受影响，跟随视角下地平线柔和过渡
  const fogNear = Math.hypot(...view.shot.eye.map((v, i) => v - (view.shot.look[i] ?? 0))) + Math.hypot(area.width_m, area.height_m) / 2;
  return (
    <Canvas flat shadows="soft" frameloop="demand">
      <color attach="background" args={[BACKGROUND]} />
      <fog attach="fog" args={[BACKGROUND, fogNear, fogNear + FOG_M]} />
      <ViewCamera view={view} />
      <FirstFrame onReady={onReady} />
      <Lights area={area} />
      <ShadowCatcher area={area} />
      <AreaScene area={area} items={items} />
      <DeviceMarkers cameras={cameras} />
      <TargetModels cameras={cameras} />
    </Canvas>
  );
}

/** 光照强度：朝上的受光面总辐照约为 π，Lambert 材质在受光面呈现规定的材质色（设计 150 §4） */
const HEMI_INTENSITY = 1.5;
const SUN_INTENSITY = 2;

/** 半球光 + 平行主光；主光的阴影相机贴合区域，阴影清晰且不浪费贴图 */
export function Lights({ area }: { area: Area }) {
  const [cx, cz] = [area.x0 + area.width_m / 2, area.y0 + area.height_m / 2];
  const target = useMemo(() => new Object3D(), []);
  const radius = Math.hypot(area.width_m, area.height_m) / 2 + SHADOW_MARGIN_M;
  const sun: [number, number, number] = [
    cx + radius * Math.cos(SUN_ELEVATION) * Math.cos(SUN_AZIMUTH),
    radius * Math.sin(SUN_ELEVATION),
    cz + radius * Math.cos(SUN_ELEVATION) * Math.sin(SUN_AZIMUTH),
  ];
  return (
    <>
      <hemisphereLight args={["#FFFFFF", "#E5E7EB", HEMI_INTENSITY]} />
      <primitive object={target} position={[cx, 0, cz]} />
      <directionalLight
        position={sun}
        target={target}
        intensity={SUN_INTENSITY}
        castShadow
        shadow-mapSize={[SHADOW_MAP, SHADOW_MAP]}
        shadow-bias={-0.0005}
        shadow-normalBias={0.02}
        shadow-camera-left={-radius}
        shadow-camera-right={radius}
        shadow-camera-top={radius}
        shadow-camera-bottom={-radius}
        shadow-camera-near={0.5}
        shadow-camera-far={radius * 2 + 10}
      />
    </>
  );
}

/** 只显示阴影的承接面：区域加边距，略高于地面，不接收点选 */
export function ShadowCatcher({ area }: { area: Area }) {
  const [w, h] = [area.width_m + SHADOW_MARGIN_M * 2, area.height_m + SHADOW_MARGIN_M * 2];
  return (
    <mesh
      rotation-x={-Math.PI / 2}
      position={[area.x0 + area.width_m / 2, -0.002, area.y0 + area.height_m / 2]}
      receiveShadow
      raycast={() => undefined}
    >
      <planeGeometry args={[w, h]} />
      <shadowMaterial opacity={SHADOW_OPACITY} transparent depthWrite={false} />
    </mesh>
  );
}

/** 透视相机按机位摆放，与 layout.ts 的 sceneView 投影一致：画面中心平移到取景中心的像素位置 */
function ViewCamera({ view }: { view: SceneView }) {
  const get = useThree((s) => s.get);
  useLayoutEffect(() => {
    // 在副作用中经 get() 取相机并直接修改：R3F 推荐的命令式写法
    const state = get();
    const camera = state.camera as PerspectiveCamera;
    const { width, height } = state.size;
    const { eye, look, fov, center } = view.shot;
    camera.position.set(...eye);
    camera.fov = (fov * 180) / Math.PI;
    camera.near = view.near;
    camera.far = view.far;
    camera.setViewOffset(width, height, width / 2 - center[0], height / 2 - center[1], width, height);
    camera.lookAt(...look);
    camera.updateProjectionMatrix();
    state.invalidate();
  }, [get, view]);
  return null;
}

export function FirstFrame({ onReady }: { onReady: () => void }) {
  const done = useRef(false);
  const gl = useThree((s) => s.gl);
  // 只在 e2e 构建中提供：最近一帧的绘制调用数，用于核对实例化渲染（C-FE-04、SC-10）
  useEffect(() => {
    if (import.meta.env.MODE !== "e2e") return;
    window.__hydDrawCalls = () => gl.info.render.calls;
    return () => {
      delete window.__hydDrawCalls;
    };
  }, [gl]);
  useFrame(() => {
    if (done.current) return;
    done.current = true;
    onReady();
  });
  return null;
}
