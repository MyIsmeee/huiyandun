import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Object3D, OrthographicCamera } from "three";
import type { Site } from "../lib/api";
import { useTheme } from "../theme/store";
import { DeviceMarkers } from "./DeviceMarkers";
import { TargetModels } from "./TargetModels";
import type { Camera } from "./devices";
import { GROUND_M, type IsoView, type Vec3, WALL_HEIGHT_M } from "./layout";
import { type Lighting, lightingAt, lightStep } from "./lighting";

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
 * 3D 场景（§5.1 L0 地面与栅格、L2 设备、L3 视场、L4 检出目标、光照）；平面图只用于定位，不显示（UP-1）。
 * 按需渲染（frameloop="demand"）：无常驻动效（V-A3），只有对应真实告警的动效持续请求重绘。
 * flat 关闭色调映射，地面等色值与规范一致；阴影另以阴影材质叠加在地面上，不改变地面色值。
 */
export default function Scene3D(props: { site: Site; cameras: Camera[]; view: IsoView; onReady: () => void }) {
  const { site, cameras, view, onReady } = props;
  useTheme((s) => s.theme); // 订阅主题：切换时重新渲染并取色
  const colors = themeColors();
  const lighting = useLighting();
  const center: Vec3 = [site.width_m / 2, 0, site.height_m / 2];
  return (
    <Canvas orthographic flat shadows="percentage" frameloop="demand">
      <IsoCamera view={view} />
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
      <Grid center={center} color={colors.grid} />
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

function IsoCamera({ view }: { view: IsoView }) {
  const get = useThree((s) => s.get);
  useLayoutEffect(() => {
    // 在副作用中经 get() 取相机并直接修改：R3F 推荐的命令式写法
    const state = get();
    const camera = state.camera as OrthographicCamera;
    camera.position.set(...view.position);
    camera.zoom = view.zoom;
    camera.near = view.near;
    camera.far = view.far;
    camera.lookAt(...view.target);
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

/** 1 m 比例尺栅格，与地面同样无限延伸（§5.1 L0） */
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
      <lineBasicMaterial color={color} />
    </lineSegments>
  );
}
