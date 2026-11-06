import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useLayoutEffect, useRef } from "react";
import type { PerspectiveCamera } from "three";
import type { Site } from "../lib/api";
import { DeviceMarkers } from "./DeviceMarkers";
import { TargetModels } from "./TargetModels";
import type { Camera } from "./devices";
import type { SceneView } from "./layout";
import { PerceivedScene } from "./PerceivedScene";
import { Sandbox } from "./Sandbox";

/** 页面底色（04 §3.1），场景背景与远处渐隐取同色 */
const BACKGROUND = "#070B14";
/** 渐隐的过渡距离，单位米 */
const FOG_M = 50;

/**
 * 3D 数字沙盘（04 §5.1、D-104）：L0 站点底板与墙体、L1 感知场景、L2 设备、L3 视场、L4 检出目标。
 * 光照固定，不投射阴影（V-A6 已删除）。按需渲染（frameloop="demand"）：无常驻动效（V-A3），
 * 只有对应真实告警的动效持续请求重绘。flat 关闭色调映射，色值与规范一致。
 */
export default function Scene3D(props: { site: Site; cameras: Camera[]; view: SceneView; onReady: () => void }) {
  const { site, cameras, view, onReady } = props;
  // 远处渐隐为底色：站点在取景中心周围时始终不受影响，跟随视角下地平线柔和过渡
  const fogNear = Math.hypot(...view.shot.eye.map((v, i) => v - (view.shot.look[i] ?? 0))) + Math.hypot(site.width_m, site.height_m) / 2;
  return (
    <Canvas flat frameloop="demand">
      <color attach="background" args={[BACKGROUND]} />
      <fog attach="fog" args={[BACKGROUND, fogNear, fogNear + FOG_M]} />
      <ViewCamera view={view} />
      <FirstFrame onReady={onReady} />
      <ambientLight intensity={1.6} />
      <directionalLight position={[-0.4, 1, -0.3]} intensity={1.4} />
      <Sandbox site={site} />
      <PerceivedScene cameras={cameras} />
      <DeviceMarkers cameras={cameras} />
      <TargetModels cameras={cameras} />
    </Canvas>
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
