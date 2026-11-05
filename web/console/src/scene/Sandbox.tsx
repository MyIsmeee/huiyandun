import { useMemo } from "react";
import { AdditiveBlending, BufferGeometry, DoubleSide, Float32BufferAttribute } from "three";
import type { Site } from "../lib/api";
import { WALL_HEIGHT_M } from "./layout";

/** 沙盘青（04 §3.1、V-S5）：底板边缘、栅格、墙体线框；不表达状态 */
export const SANDBOX = "#3CC8F0";
const SLAB = "#0B1626";
const SLAB_M = 0.3;

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

/** 墙面（竖直四边形）与棱线（上下边、端线）的顶点 */
function wallGeometry(segments: Segment[]): { faces: BufferGeometry; edges: BufferGeometry } {
  const faces: number[] = [];
  const edges: number[] = [];
  const h = WALL_HEIGHT_M;
  for (const [x1, y1, x2, y2] of segments) {
    faces.push(x1, 0, y1, x2, 0, y2, x2, h, y2, x1, 0, y1, x2, h, y2, x1, h, y1);
    edges.push(x1, h, y1, x2, h, y2, x1, 0.01, y1, x2, 0.01, y2, x1, 0, y1, x1, h, y1, x2, 0, y2, x2, h, y2);
  }
  const geometry = (values: number[]) => new BufferGeometry().setAttribute("position", new Float32BufferAttribute(values, 3));
  return { faces: geometry(faces), edges: geometry(edges) };
}

/** 底板顶面的 1 m 栅格与四周边缘 */
function slabLines(width: number, height: number): { grid: BufferGeometry; rim: BufferGeometry } {
  const grid: number[] = [];
  for (let x = 1; x < width; x += 1) grid.push(x, 0.005, 0, x, 0.005, height);
  for (let y = 1; y < height; y += 1) grid.push(0, 0.005, y, width, 0.005, y);
  const rim = [0, 0, 0, width, 0, 0, width, 0, 0, width, 0, height, width, 0, height, 0, 0, height, 0, 0, height, 0, 0, 0];
  const geometry = (values: number[]) => new BufferGeometry().setAttribute("position", new Float32BufferAttribute(values, 3));
  return { grid: geometry(grid), rim: geometry(rim.map((v, i) => (i % 3 === 1 ? 0.01 : v))) };
}

/**
 * 数字沙盘的底板与墙体（04 §5.1 L0、D-104）：按 site.yaml 的站点尺寸画 0.3 m 厚底板，顶面 1 m 栅格、
 * 四周边缘发光；墙体为 2.8 m 半透明青色立面，门洞处断开。发光以叠加混合的半透明面与双层线条实现，不用后处理。
 */
export function Sandbox({ site }: { site: Site }) {
  const { width_m: width, height_m: height } = site;
  const lines = useMemo(() => slabLines(width, height), [width, height]);
  const walls = useMemo(() => wallGeometry(wallSegments(site.walls, site.doors)), [site.walls, site.doors]);
  return (
    <>
      <mesh position={[width / 2, -SLAB_M / 2, height / 2]}>
        <boxGeometry args={[width, SLAB_M, height]} />
        <meshBasicMaterial color={SLAB} />
      </mesh>
      <lineSegments geometry={lines.grid}>
        <lineBasicMaterial color={SANDBOX} transparent opacity={0.1} depthWrite={false} />
      </lineSegments>
      {/* 边缘：内线清晰，外侧放大一点的同色线叠加出光晕 */}
      <lineSegments geometry={lines.rim}>
        <lineBasicMaterial color={SANDBOX} transparent opacity={0.9} />
      </lineSegments>
      <lineSegments geometry={lines.rim} scale={[1.004, 1, 1.006]} position={[-width * 0.002, 0, -height * 0.003]}>
        <lineBasicMaterial color={SANDBOX} transparent opacity={0.25} blending={AdditiveBlending} depthWrite={false} />
      </lineSegments>
      <mesh geometry={walls.faces}>
        <meshBasicMaterial color={SANDBOX} transparent opacity={0.06} side={DoubleSide} blending={AdditiveBlending} depthWrite={false} />
      </mesh>
      <lineSegments geometry={walls.edges}>
        <lineBasicMaterial color={SANDBOX} transparent opacity={0.55} depthWrite={false} />
      </lineSegments>
    </>
  );
}
