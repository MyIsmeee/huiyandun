import { useMemo } from "react";
import { BoxGeometry, type BufferGeometry, CylinderGeometry, DoubleSide, Shape, ShapeGeometry, SphereGeometry } from "three";
import type { SceneFrame } from "../editor/recognition";
import { MATERIALS } from "./assets";

type Point = [number, number];

/** 墙厚、桌面厚、腿粗（米） */
const WALL_T = 0.12;
const TOP_T = 0.04;
const LEG = 0.05;
/** 椅子：座高、座面厚、靠背高；识别的椅子底面常连带坐着的人，按常见尺寸截断 */
const SEAT_M = 0.45;
const CHAIR_MAX_M = 0.6;
/** 物体底面长边上限：超出的多是把一排东西连在一起，截断免得一块板横穿房间 */
const OBJECT_MAX_M = 3.5;

/** 底面多边形（最小外接矩形的 4 个角）→ 中心、长、宽、绕竖直轴的转角（场景坐标：平面 (x, y) → (x, 0, y)） */
function rect(polygon: number[][]): { center: Point; length: number; width: number; angle: number } {
  const p = polygon.map(([x = 0, y = 0]) => [x, y] as Point);
  const center: Point = [p.reduce((s, q) => s + q[0], 0) / p.length, p.reduce((s, q) => s + q[1], 0) / p.length];
  const [a, b, c] = [p[0] ?? center, p[1] ?? center, p[2] ?? center];
  const e1 = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const e2 = Math.hypot(c[0] - b[0], c[1] - b[1]);
  const [long, from, to] = e1 >= e2 ? [e1, a, b] : [e2, b, c];
  return { center, length: long, width: Math.min(e1, e2), angle: -Math.atan2(to[1] - from[1], to[0] - from[0]) };
}

interface Part {
  geometry: BufferGeometry;
  position: [number, number, number];
  rotation: number;
  color: string;
}

function box(l: number, h: number, w: number, at: Point, y: number, angle: number, color: string, dx = 0, dz = 0): Part {
  // dx、dz 为物体自身坐标系中的偏移（长边方向、宽边方向）
  const [c, s] = [Math.cos(-angle), Math.sin(-angle)];
  return {
    geometry: new BoxGeometry(Math.max(l, 0.02), Math.max(h, 0.02), Math.max(w, 0.02)),
    position: [at[0] + dx * c - dz * s, y, at[1] + dx * s + dz * c],
    rotation: angle,
    color,
  };
}

function objectParts(o: SceneFrame["objects"][number]): Part[] {
  const { center, length: measuredLength, width: measuredWidth, angle } = rect(o.polygon);
  const length = Math.min(measuredLength, OBJECT_MAX_M);
  const width = Math.min(measuredWidth, OBJECT_MAX_M);
  const h = o.height_m;
  const legs = (l: number, w: number, top: number) =>
    [-1, 1].flatMap((i) =>
      [-1, 1].map((j) => box(LEG, top, LEG, center, top / 2, angle, MATERIALS.furniture, i * (l / 2 - LEG), j * (w / 2 - LEG))),
    );
  switch (o.class) {
    case "table":
      return [box(length, TOP_T, width, center, h - TOP_T / 2, angle, MATERIALS.wall), ...legs(length, width, h - TOP_T)];
    case "chair": {
      const [l, w] = [Math.min(length, CHAIR_MAX_M), Math.min(width, CHAIR_MAX_M)];
      const back = Math.max(h, SEAT_M + 0.35) - SEAT_M;
      return [
        box(l, TOP_T, w, center, SEAT_M, angle, MATERIALS.wall),
        box(l, back, TOP_T, center, SEAT_M + back / 2, angle, MATERIALS.wall, 0, w / 2 - TOP_T / 2),
        ...legs(l, w, SEAT_M - TOP_T / 2),
      ];
    }
    default:
      return [box(length, h, width, center, h / 2, angle, MATERIALS.wall)];
  }
}

/**
 * 按实测尺寸呈现自动识别的场景（白模）：不套用编辑器的网格资产——资产尺寸固定、吸附整米网格，互相重叠的会被丢掉，
 * 实测的长宽、高度与朝向都用不上。墙按墙脚线挤出实测高度；桌子为桌面加四条腿；椅子为座面、靠背加腿；其余按底面挤出成块
 */
export function MeasuredScene({ frames }: { frames: SceneFrame[] }) {
  const parts = useMemo(() => {
    const list: Part[] = [];
    for (const frame of frames) {
      for (const wall of frame.walls) {
        if (wall.class === "board") continue;
        for (let i = 1; i < wall.line.length; i += 1) {
          const [a, b] = [wall.line[i - 1] ?? [0, 0], wall.line[i] ?? [0, 0]];
          const [ax = 0, ay = 0, bx = 0, by = 0] = [a[0], a[1], b[0], b[1]];
          const length = Math.hypot(bx - ax, by - ay);
          list.push(box(length, wall.height_m, WALL_T, [(ax + bx) / 2, (ay + by) / 2], wall.height_m / 2, -Math.atan2(by - ay, bx - ax), MATERIALS.wall));
        }
      }
      for (const o of frame.objects) list.push(...objectParts(o));
      for (const t of frame.trees) {
        list.push({ geometry: new CylinderGeometry(0.08, 0.1, t.height_m * 0.5, 8), position: [t.x, t.height_m * 0.25, t.y], rotation: 0, color: MATERIALS.furniture });
        list.push({ geometry: new SphereGeometry(Math.max(0.3, t.height_m * 0.25), 12, 8), position: [t.x, t.height_m * 0.7, t.y], rotation: 0, color: MATERIALS.canopy });
      }
    }
    return list;
  }, [frames]);
  const floors = useMemo(
    () =>
      frames.flatMap((f) =>
        f.surfaces.map((s) => {
          const shape = new Shape(s.polygon.map(([x = 0, y = 0]) => ({ x, y }) as never));
          return { geometry: new ShapeGeometry(shape), color: s.class === "grass" ? MATERIALS.grass : MATERIALS.plaza };
        }),
      ),
    [frames],
  );
  return (
    <group raycast={() => undefined}>
      {floors.map(({ geometry, color }, i) => (
        // ShapeGeometry 在 xy 平面：绕 x 轴转 +90° 后平面 y 落到场景 z
        <mesh key={`f${i}`} geometry={geometry} rotation-x={Math.PI / 2} position-y={0.004} receiveShadow raycast={() => undefined}>
          <meshLambertMaterial color={color} side={DoubleSide} />
        </mesh>
      ))}
      {parts.map(({ geometry, position, rotation, color }, i) => (
        <mesh key={i} geometry={geometry} position={position} rotation-y={rotation} castShadow receiveShadow raycast={() => undefined}>
          <meshLambertMaterial color={color} />
        </mesh>
      ))}
    </group>
  );
}
