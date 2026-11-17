import { useEffect, useMemo } from "react";
import {
  BoxGeometry,
  type BufferGeometry,
  CylinderGeometry,
  DoubleSide,
  Euler,
  Matrix4,
  Quaternion,
  Shape,
  ShapeGeometry,
  SphereGeometry,
  TorusGeometry,
  Vector3,
} from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { SceneFrame } from "../editor/recognition";
import { PlacedModels } from "./AreaScene";
import { MATERIALS, useCatalog } from "./assets";
import { measuredModels } from "./measuredModels";
import type { Camera } from "./devices";
import { furniture, type Piece, type Tone } from "./furniture";

type Point = [number, number];

/** 墙厚（米） */
const WALL_T = 0.12;
/** 零件色调 → 颜色：主体白、骨架浅灰、缝线与把手深一档 */
const TONES: Record<Tone, string> = { body: MATERIALS.wall, frame: MATERIALS.furniture, detail: MATERIALS.roof };

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

function box(l: number, h: number, w: number, at: Point, y: number, angle: number, color: string): Part {
  return { geometry: new BoxGeometry(Math.max(l, 0.02), Math.max(h, 0.02), Math.max(w, 0.02)), position: [at[0], y, at[1]], rotation: angle, color };
}

function geometryOf({ shape, size }: Piece): BufferGeometry {
  if (shape === "cylinder") return new CylinderGeometry(size[0], size[2], size[1], 20);
  if (shape === "torus") return new TorusGeometry(size[0], size[1], 6, 24).rotateX(Math.PI / 2);
  return new BoxGeometry(...size);
}

/**
 * 一件家具的零件（furniture.ts）摆到场景中：物体自身 +z（正面）转向识别它的摄像头一侧。
 * 绕竖直轴转 angle 时自身 x 轴指向平面 (cos angle, −sin angle)，z 轴指向 (sin angle, cos angle)
 */
export function objectParts(o: SceneFrame["objects"][number], camera?: Point): Part[] {
  const { center, length, width, angle: base } = rect(o.polygon);
  const toward = camera ? (camera[0] - center[0]) * Math.sin(base) + (camera[1] - center[1]) * Math.cos(base) : 1;
  const angle = toward < 0 ? base + Math.PI : base;
  const [c, s] = [Math.cos(angle), Math.sin(angle)];
  // 放在桌面、柜顶上的小件物品从 base_m 起画
  const lift = o.base_m ?? 0;
  return furniture(o.class, o.kind, length, width, Math.max(o.height_m - lift, 0.05)).pieces.map((piece) => {
    const [x, y, z] = piece.at;
    return {
      geometry: geometryOf(piece),
      position: [center[0] + x * c + z * s, y + lift, center[1] - x * s + z * c],
      rotation: angle + (piece.yaw ?? 0),
      color: TONES[piece.tone],
    };
  });
}

/**
 * 按实测尺寸呈现自动识别的场景（白模）：不套用编辑器的网格资产——资产尺寸固定、吸附整米网格，互相重叠的会被丢掉，
 * 实测的长宽、高度与朝向都用不上。墙按墙脚线挤出实测高度；家具按细分类别与实测尺寸选画法（furniture.ts：
 * 书桌、会议桌、圆桌、茶几、吧台桌，转椅、凳子、吧凳、扶手椅、长凳，书架、衣柜、斗柜、文件柜、矮柜，沙发、床等）
 */
export function MeasuredScene({ frames, cameras = [] }: { frames: SceneFrame[]; cameras?: Camera[] }) {
  // 只按摄像头位置重建几何：cameras 随状态推送逐次换新数组
  const eyes = JSON.stringify(Object.fromEntries(cameras.map((c) => [c.id, [c.pose.x, c.pose.y]])));
  const catalog = useCatalog();
  // 电器、箱包与卫浴摆放模型库中的对应模型，其余物体按实测尺寸拼画
  const models = useMemo(() => measuredModels(frames, catalog, JSON.parse(eyes) as Record<string, Point>), [frames, catalog, eyes]);
  const parts = useMemo(() => {
    const at = JSON.parse(eyes) as Record<string, Point>;
    const list: Part[] = [];
    for (const frame of frames) {
      const eye = at[frame.camera_id];
      for (const wall of frame.walls) {
        if (wall.class === "board") continue;
        for (let i = 1; i < wall.line.length; i += 1) {
          const [a, b] = [wall.line[i - 1] ?? [0, 0], wall.line[i] ?? [0, 0]];
          const [ax = 0, ay = 0, bx = 0, by = 0] = [a[0], a[1], b[0], b[1]];
          const length = Math.hypot(bx - ax, by - ay);
          list.push(box(length, wall.height_m, WALL_T, [(ax + bx) / 2, (ay + by) / 2], wall.height_m / 2, -Math.atan2(by - ay, bx - ax), MATERIALS.wall));
        }
      }
      for (const o of frame.objects) if (!models.placed.has(o)) list.push(...objectParts(o, eye));
      for (const t of frame.trees) {
        list.push({ geometry: new CylinderGeometry(0.08, 0.1, t.height_m * 0.5, 8), position: [t.x, t.height_m * 0.25, t.y], rotation: 0, color: MATERIALS.furniture });
        list.push({ geometry: new SphereGeometry(Math.max(0.3, t.height_m * 0.25), 12, 8), position: [t.x, t.height_m * 0.7, t.y], rotation: 0, color: MATERIALS.canopy });
      }
    }
    return byColor(list.map(({ geometry, position, rotation, color }) => ({ geometry: placed(geometry, position, rotation), color })));
  }, [frames, eyes, models]);
  const floors = useMemo(
    () =>
      byColor(
        frames.flatMap((f) =>
          f.surfaces.map((s) => {
            const shape = new Shape(s.polygon.map(([x = 0, y = 0]) => ({ x, y }) as never));
            return { geometry: new ShapeGeometry(shape), color: s.class === "grass" ? MATERIALS.grass : MATERIALS.plaza };
          }),
        ),
      ),
    [frames],
  );
  // 几何经 geometry 属性传入，R3F 卸载时不代为释放：识别结果每 10 分钟更新一次，换新时释放旧的，免得显存逐次累积
  useEffect(() => () => parts.forEach(({ geometry }) => geometry.dispose()), [parts]);
  useEffect(() => () => floors.forEach(({ geometry }) => geometry.dispose()), [floors]);
  return (
    <group raycast={() => undefined}>
      {floors.map(({ geometry, color }, i) => (
        // ShapeGeometry 在 xy 平面：绕 x 轴转 +90° 后平面 y 落到场景 z
        <mesh key={`f${i}`} geometry={geometry} rotation-x={Math.PI / 2} position-y={0.004} receiveShadow raycast={() => undefined}>
          <meshLambertMaterial color={color} side={DoubleSide} />
        </mesh>
      ))}
      {parts.map(({ geometry, color }, i) => (
        <mesh key={i} geometry={geometry} castShadow receiveShadow raycast={() => undefined}>
          <meshLambertMaterial color={color} />
        </mesh>
      ))}
      <PlacedModels groups={models.groups} />
    </group>
  );
}

const [offset, turn, unit] = [new Vector3(), new Quaternion(), new Vector3(1, 1, 1)];
const yaw = new Euler();
const matrix = new Matrix4();

/** 零件几何烘焙到场景坐标：先绕竖直轴转 rotation，再平移到 position */
function placed(geometry: BufferGeometry, position: [number, number, number], rotation: number): BufferGeometry {
  return geometry.applyMatrix4(matrix.compose(offset.set(...position), turn.setFromEuler(yaw.set(0, rotation, 0)), unit));
}

/**
 * 同色的几何合并为一个网格（V-P1）：白模的墙、家具零件可达数百件，逐件一个网格时绘制次数随之增长，阴影再翻一倍。
 * 合并后绘制次数只与色调数有关；合并完的源几何即释放
 */
function byColor(list: { geometry: BufferGeometry; color: string }[]): { geometry: BufferGeometry; color: string }[] {
  const groups = new Map<string, BufferGeometry[]>();
  for (const { geometry, color } of list) {
    const group = groups.get(color);
    if (group) group.push(geometry);
    else groups.set(color, [geometry]);
  }
  return [...groups].flatMap(([color, geometries]) => {
    const merged = mergeGeometries(geometries);
    geometries.forEach((g) => g.dispose());
    return merged ? [{ geometry: merged, color }] : [];
  });
}
