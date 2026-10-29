import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Object3D, PerspectiveCamera } from "three";
import type { Site } from "../lib/api";
import { useTheme } from "../theme/store";
import { useCamera } from "./camera";
import { DeviceMarkers } from "./DeviceMarkers";
import { TargetModels } from "./TargetModels";
import type { Camera } from "./devices";
import { GROUND_M, type SceneView, type Vec3, WALL_HEIGHT_M } from "./layout";
import { type Lighting, lightingAt, lightStep } from "./lighting";
import { PerceivedScene } from "./PerceivedScene";

/** 渐隐的过渡距离，单位米 */
const FOG_M = 50;

/** 取当前主题的色值（theme.css），场景与界面同源（§3.1、§5.1） */
function themeColors() {
  const style = getComputedStyle(document.documentElement);
  const read = (name: string) => style.getPropertyValue(name).trim();
  return { ground: read("--hyd-ground"), grid: read("--hyd-grid") };
}

/** 光照按 10 分钟步进更新（V-A6）：每分钟检查一次，步进未变时不重新渲染 */
function useLighting(): Lighting {
  const [step, setStep] = useState(() => lightStep(new Date()));
  useEffect(() => {
    const id = setInterval(() => setStep(lightStep(new Date())), 60_000);
    return () => clearInterval(id);
  }, []);
  return useMemo(() => lightingAt(step), [step]);
}

/**
 * 3D 场景（§5.1 L0 地面与栅格、L1 感知场景、L2 设备、L3 视场、L4 检出目标、光照）；平面图只用于定位，不显示（UP-1）。
 * 按需渲染（frameloop="demand"）：无常驻动效（V-A3），只有对应真实告警的动效持续请求重绘。
 * flat 关闭色调映射，地面等色值与规范一致；阴影另以阴影材质叠加在地面与地面色块之上（地面色块先绘制），不改变其色值。
 */
export default function Scene3D(props: { site: Site; cameras: Camera[]; view: SceneView; onReady: () => void }) {
  const { site, cameras, view, onReady } = props;
  useTheme((s) => s.theme); // 订阅主题：切换时重新渲染并取色
  const colors = themeColors();
  const lighting = useLighting();
  // 1 m 栅格是总览的比例尺；跟随与摄像头视角贴近地面，栅格在透视下挤成密集条纹，不画（车机 SR 同样没有栅格）。
  // 飞入、飞回途中同样不画，回到总览后再出现
  const hideGrid = useCamera((s) => s.focus !== null || s.shot !== null);
  const center: Vec3 = [site.width_m / 2, 0, site.height_m / 2];
  // 远处渐隐为地面色（透视下远处 1 m 栅格挤成密集条纹）：站点在取景中心周围时始终不受影响，跟随视角下地平线柔和过渡
  const fogNear = Math.hypot(...view.shot.eye.map((v, i) => v - (view.shot.look[i] ?? 0))) + Math.hypot(site.width_m, site.height_m) / 2;
  return (
    <Canvas flat shadows="percentage" frameloop="demand">
      <color attach="background" args={[colors.ground]} />
      <fog attach="fog" args={[colors.ground, fogNear, fogNear + FOG_M]} />
      <ViewCamera view={view} />
      <FirstFrame onReady={onReady} />
      <Lights site={site} lighting={lighting} />
      <mesh rotation-x={-Math.PI / 2} position={center}>
        <planeGeometry args={[GROUND_M, GROUND_M]} />
        <meshBasicMaterial color={colors.ground} />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} position={center} position-y={0.002} receiveShadow>
        <planeGeometry args={[GROUND_M, GROUND_M]} />
        <shadowMaterial opacity={lighting.shadowOpacity} />
      </mesh>
      {!hideGrid && <Grid center={center} color={colors.grid} />}
      <PerceivedScene cameras={cameras} />
      <DeviceMarkers cameras={cameras} />
      <TargetModels cameras={cameras} />
    </Canvas>
  );
}

/** 环境光 + 主光（白天为太阳、夜间为月光）；主光投射柔和阴影，阴影相机覆盖整个站点 */
function Lights({ site, lighting }: { site: Site; lighting: Lighting }) {
  const [target, setTarget] = useState<Object3D | null>(null);
  const center: Vec3 = [site.width_m / 2, 0, site.height_m / 2];
  const reach = Math.hypot(site.width_m, site.height_m) / 2 + WALL_HEIGHT_M;
  const [dx, dy, dz] = lighting.direction;
  return (
    <>
      <ambientLight intensity={lighting.ambient} />
      <object3D ref={setTarget} position={center} />
      {target && (
        <directionalLight
          target={target}
          position={[center[0] + dx * reach * 2, dy * reach * 2, center[2] + dz * reach * 2]}
          intensity={lighting.sun}
          castShadow
          shadow-mapSize={[2048, 2048]}
          shadow-radius={4}
          shadow-bias={-0.0005}
          shadow-camera-left={-reach}
          shadow-camera-right={reach}
          shadow-camera-top={reach}
          shadow-camera-bottom={-reach}
          shadow-camera-near={0.5}
          shadow-camera-far={reach * 4}
          onUpdate={(light) => light.shadow.camera.updateProjectionMatrix()}
        />
      )}
    </>
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

function FirstFrame({ onReady }: { onReady: () => void }) {
  const done = useRef(false);
  useFrame(() => {
    if (done.current) return;
    done.current = true;
    onReady();
  });
  return null;
}

/**
 * 1 m 比例尺栅格，与地面同样无限延伸（§5.1 L0）。
 * 不写深度：贴地的阴影、视场与地面色块只与地面比深度，不被栅格线切开，地面色块直接盖住栅格
 */
function Grid({ center: [cx, , cz], color }: { center: Vec3; color: string }) {
  const positions = useMemo(() => {
    const p: number[] = [];
    const [x0, z0] = [Math.round(cx - GROUND_M / 2), Math.round(cz - GROUND_M / 2)];
    for (let k = 0; k <= GROUND_M; k += 1) {
      p.push(x0 + k, 0.005, z0, x0 + k, 0.005, z0 + GROUND_M);
      p.push(x0, 0.005, z0 + k, x0 + GROUND_M, 0.005, z0 + k);
    }
    return new Float32Array(p);
  }, [cx, cz]);
  return (
    <lineSegments>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <lineBasicMaterial color={color} depthWrite={false} />
    </lineSegments>
  );
}
