import { Canvas, extend, type ThreeElement, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { DoubleSide, type Object3D, type OrthographicCamera, Shape, Vector2 } from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import type { Site } from "../lib/api";
import { useTheme } from "../theme/store";
import { DeviceMarkers } from "./DeviceMarkers";
import { PersonAvatars } from "./PersonAvatars";
import type { Camera } from "./devices";
import { type IsoView, type Vec3, WALL_HEIGHT_M, WALL_THICKNESS_M } from "./layout";
import { type Lighting, lightingAt, lightStep } from "./lighting";
import { isNearSide, type WallPiece, wallPieces } from "./walls";

extend({ RoundedBoxGeometry });
declare module "@react-three/fiber" {
  interface ThreeElements {
    roundedBoxGeometry: ThreeElement<typeof RoundedBoxGeometry>;
  }
}

/** 取当前主题的色值（theme.css），场景与界面同源（§3.1、§5.1） */
function themeColors() {
  const style = getComputedStyle(document.documentElement);
  const read = (name: string) => style.getPropertyValue(name).trim();
  return { ground: read("--hyd-raised"), grid: read("--hyd-grid"), wall: read("--hyd-text-3"), zone: read("--hyd-text-2") };
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
 * 由平面图生成的 3D 场景（§5.1 L0 地面与栅格、L1 墙体与门洞、区域轮廓、L2 设备、L3 视场、L4 人员、光照）。
 * 按需渲染（frameloop="demand"）：无常驻动效（V-A3），只有对应真实告警的动效持续请求重绘。
 * flat 关闭色调映射，地面等色值与规范一致；阴影另以阴影材质叠加在地面上，不改变地面色值。
 */
export default function Scene3D(props: { site: Site; cameras: Camera[]; view: IsoView; onReady: () => void }) {
  const { site, cameras, view, onReady } = props;
  useTheme((s) => s.theme); // 订阅主题：切换时重新渲染并取色
  const colors = themeColors();
  const lighting = useLighting();
  const pieces = useMemo(() => wallPieces(site.walls, site.doors), [site.walls, site.doors]);
  const ground = { position: [site.width_m / 2, 0, site.height_m / 2] as const, size: [site.width_m, site.height_m] as const };
  return (
    <Canvas orthographic flat shadows="percentage" frameloop="demand">
      <IsoCamera view={view} />
      <FirstFrame onReady={onReady} />
      <Lights site={site} lighting={lighting} />
      <mesh rotation-x={-Math.PI / 2} position={ground.position}>
        <planeGeometry args={ground.size} />
        <meshBasicMaterial color={colors.ground} />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} position={ground.position} position-y={0.002} receiveShadow>
        <planeGeometry args={ground.size} />
        <shadowMaterial opacity={lighting.shadowOpacity} />
      </mesh>
      <Grid width={site.width_m} height={site.height_m} color={colors.grid} />
      {site.zones.map((zone) => (
        <Zone key={zone.id} polygon={zone.polygon} color={colors.zone} />
      ))}
      {pieces.map((piece, i) => (
        <Wall key={i} piece={piece} near={isNearSide(piece.wall, site, view.toCamera)} color={colors.wall} />
      ))}
      <DeviceMarkers cameras={cameras} />
      <PersonAvatars cameras={cameras} />
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

/** 墙段：圆角长方体；近侧墙段半透明，不遮挡室内，但照常投射阴影（§5.1 L1） */
function Wall({ piece, near, color }: { piece: WallPiece; near: boolean; color: string }) {
  const [[x1, y1], [x2, y2]] = [piece.from, piece.to];
  return (
    <mesh
      position={[(x1 + x2) / 2, (piece.bottom + piece.top) / 2, (y1 + y2) / 2]}
      rotation-y={-Math.atan2(y2 - y1, x2 - x1)}
      castShadow
      receiveShadow
    >
      <roundedBoxGeometry
        args={[Math.hypot(x2 - x1, y2 - y1), piece.top - piece.bottom, WALL_THICKNESS_M, 2, 0.04]}
      />
      {/* 切换透明需重新编译着色器：以 key 在旋转后近侧变化时重建材质 */}
      <meshLambertMaterial
        key={near ? "near" : "far"}
        color={color}
        transparent={near}
        opacity={near ? 0.22 : 1}
        depthWrite={!near}
      />
    </mesh>
  );
}
