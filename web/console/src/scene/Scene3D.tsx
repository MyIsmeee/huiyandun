import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useLayoutEffect, useMemo, useRef } from "react";
import { DoubleSide, type OrthographicCamera, Shape, Vector2 } from "three";
import type { Site } from "../lib/api";
import { useTheme } from "../theme/store";
import { type IsoView, WALL_HEIGHT_M, WALL_THICKNESS_M } from "./layout";

/** 取当前主题的色值（theme.css），场景与界面同源（§3.1、§5.1） */
function themeColors() {
  const style = getComputedStyle(document.documentElement);
  const read = (name: string) => style.getPropertyValue(name).trim();
  return { ground: read("--hyd-raised"), grid: read("--hyd-grid"), wall: read("--hyd-text-3"), zone: read("--hyd-text-2") };
}

/**
 * 由平面图生成的 3D 场景（§5.1 L0 地面与栅格、L1 墙体、区域轮廓）。
 * 场景静态、按需渲染（frameloop="demand"）：无常驻动效（V-A3），断线时无需另行停止。
 * flat 关闭色调映射，地面等色值与规范一致。
 */
export default function Scene3D({ site, view, onReady }: { site: Site; view: IsoView; onReady: () => void }) {
  useTheme((s) => s.theme); // 订阅主题：切换时重新渲染并取色
  const colors = themeColors();
  return (
    <Canvas orthographic flat frameloop="demand">
      <IsoCamera view={view} />
      <FirstFrame onReady={onReady} />
      <ambientLight intensity={1.5} />
      <directionalLight position={[-20, 40, 30]} intensity={1.5} />
      <mesh rotation-x={-Math.PI / 2} position={[site.width_m / 2, 0, site.height_m / 2]}>
        <planeGeometry args={[site.width_m, site.height_m]} />
        <meshBasicMaterial color={colors.ground} />
      </mesh>
      <Grid width={site.width_m} height={site.height_m} color={colors.grid} />
      {site.zones.map((zone) => (
        <Zone key={zone.id} polygon={zone.polygon} color={colors.zone} />
      ))}
      {site.walls.map((wall, i) => (
        <Wall key={i} wall={wall} color={colors.wall} />
      ))}
    </Canvas>
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

/** 1 m 比例尺栅格 */
function Grid({ width, height, color }: { width: number; height: number; color: string }) {
  const positions = useMemo(() => {
    const p: number[] = [];
    for (let x = 0; x <= width; x += 1) p.push(x, 0.005, 0, x, 0.005, height);
    for (let z = 0; z <= height; z += 1) p.push(0, 0.005, z, width, 0.005, z);
    return new Float32Array(p);
  }, [width, height]);
  return (
    <lineSegments>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <lineBasicMaterial color={color} />
    </lineSegments>
  );
}

/** 区域：淡填充 + 轮廓，中性色，不使用状态色（V-S2） */
function Zone({ polygon, color }: { polygon: number[][]; color: string }) {
  const shape = useMemo(() => new Shape(polygon.map(([x = 0, y = 0]) => new Vector2(x, y))), [polygon]);
  const outline = useMemo(() => new Float32Array(polygon.flatMap(([x = 0, y = 0]) => [x, 0.02, y])), [polygon]);
  return (
    <>
      {/* 绕 x 轴转 90°：平面 (x, y) 落到地面 (x, 0, y) */}
      <mesh rotation-x={Math.PI / 2} position-y={0.01}>
        <shapeGeometry args={[shape]} />
        <meshBasicMaterial color={color} transparent opacity={0.08} depthWrite={false} side={DoubleSide} />
      </mesh>
      <lineLoop>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[outline, 3]} />
        </bufferGeometry>
        <lineBasicMaterial color={color} />
      </lineLoop>
    </>
  );
}

/** 墙体：沿线段拉伸为长方体，两端各延长半个墙厚使转角闭合 */
function Wall({ wall: [x1 = 0, y1 = 0, x2 = 0, y2 = 0], color }: { wall: number[]; color: string }) {
  return (
    <mesh
      position={[(x1 + x2) / 2, WALL_HEIGHT_M / 2, (y1 + y2) / 2]}
      rotation-y={-Math.atan2(y2 - y1, x2 - x1)}
    >
      <boxGeometry args={[Math.hypot(x2 - x1, y2 - y1) + WALL_THICKNESS_M, WALL_HEIGHT_M, WALL_THICKNESS_M]} />
      <meshLambertMaterial color={color} />
    </mesh>
  );
}
