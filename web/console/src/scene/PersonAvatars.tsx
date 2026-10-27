import { useLayoutEffect, useMemo, useRef } from "react";
import { CapsuleGeometry, CircleGeometry, Color, EdgesGeometry, type LineSegments } from "three";
import { useLive } from "../store/live";
import { type Camera, STATUS } from "./devices";
import { type Instance, Instanced } from "./Instanced";
import { type Avatar, avatars } from "./people";

/** 化身：低多边形胶囊，高 1.44 m，底面落在地面（§5.1 L4） */
const BODY = new CapsuleGeometry(0.22, 1, 2, 8).translate(0, 0.72, 0);
const BODY_EDGES = new EdgesGeometry(BODY, 30);
/** 不确定圆：单位半径，按 uncertainty_m 缩放 */
const DISC = new CircleGeometry(1, 32).rotateX(-Math.PI / 2).translate(0, 0.02, 0);

const EDGE_POINTS = Array.from(BODY_EDGES.getAttribute("position").array);

const color = (a: Avatar) => (a.alert ? STATUS.physical : STATUS.neutral);

/** 一组线段：顶点坐标与逐顶点颜色，合并为一次绘制（V-P1） */
type Lines = { positions: number[]; colors: number[] };

function add(lines: Lines, hex: string, points: number[]) {
  const { r, g, b } = new Color(hex);
  lines.positions.push(...points);
  for (let i = 0; i < points.length; i += 3) lines.colors.push(r, g, b);
}

/** 轨迹：近 10 s 的位置连线（V-A5） */
function trails(list: Avatar[]): Lines {
  const lines: Lines = { positions: [], colors: [] };
  for (const a of list)
    a.trail.forEach(([x, y], i) => {
      const prev = a.trail[i - 1];
      if (prev) add(lines, color(a), [prev[0], 0.03, prev[1], x, 0.03, y]);
    });
  return lines;
}

/** 高误差化身的虚线轮廓：把轮廓棱线平移到各人员位置（V-U1） */
function outlines(list: Avatar[]): Lines {
  const lines: Lines = { positions: [], colors: [] };
  for (const a of list.filter((a) => a.uncertain))
    add(lines, color(a), EDGE_POINTS.map((v, i) => v + (i % 3 === 0 ? a.x : i % 3 === 2 ? a.y : 0)));
  return lines;
}

/**
 * 人员化身 + 不确定半径 + 轨迹（§5.1 L4、L5；V-U1）。
 * 化身与不确定圆使用 InstancedMesh，轨迹与虚线轮廓各合并为一组线段，绘制次数与人数无关（V-P1）。
 */
export function PersonAvatars({ cameras }: { cameras: Camera[] }) {
  const people = useLive((s) => s.people);
  const behaviors = useLive((s) => s.behaviors);
  const list = useMemo(() => avatars(people, cameras, behaviors), [people, cameras, behaviors]);
  const bodies = list.filter((a) => !a.uncertain).map((a): Instance => ({ position: [a.x, 0, a.y], color: color(a) }));
  const discs = list.map(
    (a): Instance => ({ position: [a.x, 0, a.y], scale: [a.uncertainty_m, 1, a.uncertainty_m], color: STATUS.uncertain }),
  );
  const dashed = useMemo(() => outlines(list), [list]);
  const paths = useMemo(() => trails(list), [list]);
  return (
    <>
      <Instanced geometry={DISC} items={discs} opacity={0.2} castShadow={false} />
      <Instanced geometry={BODY} items={bodies} />
      {/* 高误差：化身改为虚线轮廓，不填充（V-U1） */}
      <Segments lines={dashed} dashed />
      <Segments lines={paths} />
    </>
  );
}

function Segments({ lines, dashed = false }: { lines: Lines; dashed?: boolean }) {
  const ref = useRef<LineSegments>(null);
  const [positions, colors] = useMemo(
    () => [new Float32Array(lines.positions), new Float32Array(lines.colors)],
    [lines],
  );
  useLayoutEffect(() => {
    if (dashed) ref.current?.computeLineDistances(); // 虚线材质需要逐段距离
  }, [positions, dashed]);
  if (positions.length === 0) return null;
  return (
    // 线段随人员移动：不做视锥剔除，免得包围球停在旧位置；顶点数变化时重建几何体
    <lineSegments ref={ref} key={positions.length} frustumCulled={false}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
        <bufferAttribute attach="attributes-color" args={[colors, 3]} />
      </bufferGeometry>
      {dashed ? <lineDashedMaterial vertexColors dashSize={0.08} gapSize={0.06} /> : <lineBasicMaterial vertexColors />}
    </lineSegments>
  );
}
