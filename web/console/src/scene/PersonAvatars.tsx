import { useMemo } from "react";
import { CapsuleGeometry, CircleGeometry, Color, EdgesGeometry } from "three";
import { useLive } from "../store/live";
import { type Camera, STATUS } from "./devices";
import { type Instance, Instanced } from "./Instanced";
import { type Avatar, avatars } from "./people";

/** 化身：低多边形胶囊，高 1.44 m，底面落在地面（§5.1 L4） */
const BODY = new CapsuleGeometry(0.22, 1, 2, 8).translate(0, 0.72, 0);
const BODY_EDGES = new EdgesGeometry(BODY, 30);
/** 不确定圆：单位半径，按 uncertainty_m 缩放 */
const DISC = new CircleGeometry(1, 32).rotateX(-Math.PI / 2).translate(0, 0.02, 0);

const color = (a: Avatar) => (a.alert ? STATUS.physical : STATUS.neutral);

/**
 * 人员化身 + 不确定半径 + 轨迹（§5.1 L4、L5；V-U1）。
 * 化身与不确定圆使用 InstancedMesh，全部轨迹合并为一组线段（V-P1）。
 */
export function PersonAvatars({ cameras }: { cameras: Camera[] }) {
  const people = useLive((s) => s.people);
  const behaviors = useLive((s) => s.behaviors);
  const list = useMemo(() => avatars(people, cameras, behaviors), [people, cameras, behaviors]);
  const bodies = list.filter((a) => !a.uncertain).map((a): Instance => ({ position: [a.x, 0, a.y], color: color(a) }));
  const discs = list.map(
    (a): Instance => ({ position: [a.x, 0, a.y], scale: [a.uncertainty_m, 1, a.uncertainty_m], color: STATUS.uncertain }),
  );
  return (
    <>
      <Instanced geometry={DISC} items={discs} opacity={0.2} castShadow={false} />
      <Instanced geometry={BODY} items={bodies} />
      {/* 高误差：化身改为虚线轮廓，不填充（V-U1） */}
      {list
        .filter((a) => a.uncertain)
        .map((a) => (
          <lineSegments key={a.key} geometry={BODY_EDGES} position={[a.x, 0, a.y]} onUpdate={(l) => l.computeLineDistances()}>
            <lineDashedMaterial color={color(a)} dashSize={0.08} gapSize={0.06} />
          </lineSegments>
        ))}
      <Trails list={list} />
    </>
  );
}

/** 轨迹：近 10 s 的位置连线（V-A5），全部人员合并为一次绘制 */
function Trails({ list }: { list: Avatar[] }) {
  const [positions, colors] = useMemo(() => {
    const [p, c]: [number[], number[]] = [[], []];
    for (const a of list) {
      const { r, g, b } = new Color(color(a));
      a.trail.forEach(([x, y], i) => {
        if (i === 0) return;
        const [px, py] = a.trail[i - 1] ?? [x, y];
        p.push(px, 0.03, py, x, 0.03, y);
        c.push(r, g, b, r, g, b);
      });
    }
    return [new Float32Array(p), new Float32Array(c)];
  }, [list]);
  if (positions.length === 0) return null;
  return (
    // 线段数变化时重建几何体：缓冲区长度在创建时确定
    <lineSegments key={positions.length}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
        <bufferAttribute attach="attributes-color" args={[colors, 3]} />
      </bufferGeometry>
      <lineBasicMaterial vertexColors />
    </lineSegments>
  );
}
