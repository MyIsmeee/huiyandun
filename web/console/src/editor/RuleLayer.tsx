import type { ThreeEvent } from "@react-three/fiber";
import { useEffect, useMemo, useState } from "react";
import { BufferGeometry, DoubleSide, Float32BufferAttribute, Line, LineBasicMaterial, LineDashedMaterial, Shape, ShapeGeometry, Vector2 } from "three";
import { STATUS } from "../scene/devices";
import { addPoint, directionArrows, snap, useRules } from "./rules";

/** 规则几何略高于地面与网格，不被遮住 */
const LIFT = 0.03;
const COLOR = STATUS.physical;

/** 平面坐标 [x, y] 的折线：场景中 x 向右、y 为 z（与目标位置同一坐标系）；JSX 的 <line> 与 SVG 同名，直接建 three 对象 */
function Polyline({ points, closed = false, dashed = false }: { points: [number, number][]; closed?: boolean; dashed?: boolean }) {
  const line = useMemo(() => {
    const path = closed && points.length > 2 ? [...points, points[0] as [number, number]] : points;
    const geometry = new BufferGeometry().setAttribute("position", new Float32BufferAttribute(path.flatMap(([x, y]) => [x, LIFT, y]), 3));
    const material = dashed ? new LineDashedMaterial({ color: COLOR, dashSize: 0.3, gapSize: 0.2 }) : new LineBasicMaterial({ color: COLOR });
    const object = new Line(geometry, material);
    if (dashed) object.computeLineDistances();
    object.raycast = () => undefined;
    return object;
  }, [points, closed, dashed]);
  useEffect(
    () => () => {
      line.geometry.dispose();
      (line.material as LineBasicMaterial).dispose();
    },
    [line],
  );
  return <primitive object={line} />;
}

/** 区域填充：半透明，便于看出范围 */
function Fill({ points }: { points: [number, number][] }) {
  const geometry = useMemo(() => {
    // ShapeGeometry 在 xy 平面，绕 x 轴转到地面后 y 对应 −z：取 −y 建形，转后回到 +z
    const shape = new Shape(points.map(([x, y]) => new Vector2(x, -y)));
    return new ShapeGeometry(shape);
  }, [points]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return (
    <mesh geometry={geometry} rotation-x={-Math.PI / 2} position-y={LIFT / 2} raycast={() => undefined}>
      <meshBasicMaterial color={COLOR} transparent opacity={0.15} depthWrite={false} side={DoubleSide} />
    </mesh>
  );
}

/** 越线正方向箭头：箭身加两翼 */
function Arrows({ points, both }: { points: [number, number][]; both: boolean }) {
  const arrows = directionArrows(points).flatMap((a) => (both ? [a, { from: a.from, to: [2 * a.from[0] - a.to[0], 2 * a.from[1] - a.to[1]] as [number, number] }] : [a]));
  return arrows.map(({ from, to }, i) => {
    const [dx, dy] = [to[0] - from[0], to[1] - from[1]];
    const wing = (k: number): [number, number] => [to[0] - dx * 0.35 + dy * 0.25 * k, to[1] - dy * 0.35 - dx * 0.25 * k];
    return <Polyline key={i} points={[from, to, wing(1), to, wing(-1)]} />;
  });
}

/**
 * 场景页的轨迹规则层：显示所选摄像头的区域（轮廓与半透明填充）与越线（折线与正方向箭头，双向时两侧都画）；
 * 绘制中单击地面加一个顶点（吸附 0.1 m），预览已点的顶点与指针所在处
 */
export function RuleLayer({ size }: { size: [number, number] }) {
  const { open, rules, drawing } = useRules();
  const [hover, setHover] = useState<[number, number] | null>(null);
  if (!open) return null;
  const preview = drawing && hover ? [...drawing.points, [snap(hover[0]), snap(hover[1])] as [number, number]] : (drawing?.points ?? []);
  return (
    <>
      {rules.map((rule) => {
        const points = rule.points as [number, number][];
        return rule.type === "intrusion" ? (
          <group key={rule.id}>
            <Fill points={points} />
            <Polyline points={points} closed />
          </group>
        ) : (
          <group key={rule.id}>
            <Polyline points={points} />
            {rule.direction === "backward" ? <Arrows points={[...points].reverse()} both={false} /> : <Arrows points={points} both={rule.direction === "any"} />}
          </group>
        );
      })}
      {drawing && (
        <>
          <mesh
            rotation-x={-Math.PI / 2}
            position={[size[0] / 2, 0, size[1] / 2]}
            onPointerMove={(e: ThreeEvent<PointerEvent>) => setHover([e.point.x, e.point.z])}
            onPointerOut={() => setHover(null)}
            onClick={(e: ThreeEvent<MouseEvent>) => {
              if (e.button !== 0) return;
              e.stopPropagation();
              addPoint(e.point.x, e.point.z);
            }}
          >
            <planeGeometry args={[size[0] + 40, size[1] + 40]} />
            <meshBasicMaterial transparent opacity={0} depthWrite={false} side={DoubleSide} />
          </mesh>
          {preview.length > 1 && <Polyline points={preview} closed={drawing.type === "intrusion"} dashed />}
          {drawing.points.map(([x, y], i) => (
            <mesh key={i} position={[x, LIFT, y]} raycast={() => undefined}>
              <sphereGeometry args={[0.12, 12, 8]} />
              <meshBasicMaterial color={COLOR} />
            </mesh>
          ))}
        </>
      )}
    </>
  );
}
