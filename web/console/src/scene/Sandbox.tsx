import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import { BufferGeometry, Float32BufferAttribute, type Mesh, MeshLambertMaterial } from "three";
import type { Site } from "../lib/api";
import { WALL_HEIGHT_M } from "./layout";

/** 实体数字孪生（04 §5.1 L0、D-111）：中性灰材质，不表达状态 */
const SLAB_TOP = "#17171A";
const SLAB_SIDE = "#0F0F11";
const WALL = "#3F3F46";
const WALL_CAP = "#71717A";
const SLAB_M = 0.3;
const WALL_THICKNESS_M = 0.24;
/** 朝向相机的近侧墙段的不透明度：不遮挡室内（04 §5.1 L0） */
const NEAR_WALL_OPACITY = 0.25;

type Segment = [number, number, number, number];

/** 墙体扣掉门洞后的线段（门洞与墙同线，FR-904 已校验） */
export function wallSegments(walls: number[][], doors: number[][]): Segment[] {
  const out: Segment[] = [];
  for (const [x1, y1, x2, y2] of walls as Segment[]) {
    const length = Math.hypot(x2 - x1, y2 - y1);
    if (length === 0) continue;
    const at = (x: number, y: number) => ((x - x1) * (x2 - x1) + (y - y1) * (y2 - y1)) / length;
    const gaps = (doors as Segment[])
      .map(([a, b, c, d]) => [at(a, b), at(c, d)].sort((p, q) => p - q) as [number, number])
      .filter(([s, e]) => e > 0 && s < length)
      .sort((p, q) => p[0] - q[0]);
    let from = 0;
    const point = (t: number): [number, number] => [x1 + ((x2 - x1) * t) / length, y1 + ((y2 - y1) * t) / length];
    for (const [s, e] of [...gaps, [length, length] as [number, number]]) {
      if (s > from) out.push([...point(from), ...point(Math.min(s, length))]);
      from = Math.max(from, e);
    }
  }
  return out;
}

/** 底板顶面的栅格（1 m 细线、5 m 粗线）与外沿 */
function slabLines(width: number, height: number): { minor: BufferGeometry; major: BufferGeometry; rim: BufferGeometry } {
  const minor: number[] = [];
  const major: number[] = [];
  for (let x = 1; x < width; x += 1) (x % 5 === 0 ? major : minor).push(x, 0.005, 0, x, 0.005, height);
  for (let y = 1; y < height; y += 1) (y % 5 === 0 ? major : minor).push(0, 0.005, y, width, 0.005, y);
  const rim = [0, 0, 0, width, 0, 0, width, 0, 0, width, 0, height, width, 0, height, 0, 0, height, 0, 0, height, 0, 0, 0];
  const geometry = (values: number[]) => new BufferGeometry().setAttribute("position", new Float32BufferAttribute(values, 3));
  return { minor: geometry(minor), major: geometry(major), rim: geometry(rim.map((v, i) => (i % 3 === 1 ? 0.01 : v))) };
}

/**
 * 站点底板与墙体（04 §5.1 L0、D-111）：按 site.yaml 的站点尺寸画 0.3 m 厚的哑光底板，顶面 1 m / 5 m 栅格；
 * 墙体为 0.24 m 厚、2.8 m 高的实体墙（立面深灰、顶盖浅灰，俯视时看清平面轮廓），门洞处断开，投射并接收阴影
 */
export function Sandbox({ site }: { site: Site }) {
  const { width_m: width, height_m: height } = site;
  const lines = useMemo(() => slabLines(width, height), [width, height]);
  const segments = useMemo(() => wallSegments(site.walls, site.doors), [site.walls, site.doors]);
  return (
    <>
      <mesh position={[width / 2, -SLAB_M / 2 - 0.001, height / 2]}>
        <boxGeometry args={[width, SLAB_M, height]} />
        <meshLambertMaterial color={SLAB_SIDE} />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} position={[width / 2, 0, height / 2]} receiveShadow>
        <planeGeometry args={[width, height]} />
        <meshLambertMaterial color={SLAB_TOP} />
      </mesh>
      <lineSegments geometry={lines.minor}>
        <lineBasicMaterial color="#FFFFFF" transparent opacity={0.04} depthWrite={false} />
      </lineSegments>
      <lineSegments geometry={lines.major}>
        <lineBasicMaterial color="#FFFFFF" transparent opacity={0.08} depthWrite={false} />
      </lineSegments>
      <lineSegments geometry={lines.rim}>
        <lineBasicMaterial color="#FFFFFF" transparent opacity={0.18} depthWrite={false} />
      </lineSegments>
      {segments.map((segment) => (
        <Wall key={segment.join()} segment={segment} center={[width / 2, height / 2]} />
      ))}
    </>
  );
}

/** 一段实体墙：相机在墙外侧（墙挡在相机与站点中心之间）时半透明 */
function Wall({ segment: [x1, y1, x2, y2], center }: { segment: Segment; center: [number, number] }) {
  const length = Math.hypot(x2 - x1, y2 - y1);
  const [mx, my] = [(x1 + x2) / 2, (y1 + y2) / 2];
  // 外法线：垂直于墙、背离站点中心
  const n = useMemo(() => {
    const [nx, ny] = [-(y2 - y1) / length, (x2 - x1) / length];
    return (mx - center[0]) * nx + (my - center[1]) * ny >= 0 ? [nx, ny] : [-nx, -ny];
  }, [x1, y1, x2, y2, length, mx, my, center]);
  const mesh = useRef<Mesh>(null);
  // 立面四个面共用一份材质，近侧半透明时一起变化；长方体六个面依次为 ±x、±y、±z，顶面（+y）为顶盖
  const materials = useMemo(() => {
    const side = new MeshLambertMaterial({ color: WALL });
    const cap = new MeshLambertMaterial({ color: WALL_CAP });
    return [side, side, cap, side, side, side];
  }, []);
  useEffect(() => () => new Set(materials).forEach((m) => m.dispose()), [materials]);
  useFrame(({ camera }) => {
    const near = (camera.position.x - mx) * (n[0] ?? 0) + (camera.position.z - my) * (n[1] ?? 0) > 0;
    for (const material of new Set(materials)) {
      material.opacity = near ? NEAR_WALL_OPACITY : 1;
      material.transparent = near;
      material.depthWrite = !near;
    }
    if (mesh.current) mesh.current.castShadow = !near;
  });
  return (
    <mesh
      ref={mesh}
      position={[mx, WALL_HEIGHT_M / 2, my]}
      rotation-y={-Math.atan2(y2 - y1, x2 - x1)}
      material={materials}
      castShadow
      receiveShadow
    >
      <boxGeometry args={[length, WALL_HEIGHT_M, WALL_THICKNESS_M]} />
    </mesh>
  );
}
