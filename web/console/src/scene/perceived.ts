import { useEffect, useState } from "react";
import {
  BoxGeometry,
  BufferAttribute,
  type BufferGeometry,
  Color,
  CylinderGeometry,
  ExtrudeGeometry,
  IcosahedronGeometry,
  Shape,
  ShapeGeometry,
  Vector2,
} from "three";
import simplify from "simplify-js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { type SceneFrame, useLive } from "../store/live";
import type { Theme } from "../theme/store";
import type { Camera } from "./devices";
import { arrange, type Furniture, isFurniture, widthOf } from "./furniture";

/** 场景帧自带的 ts 早于此时长即为陈旧，弱化显示（设计 §3.7） */
export const STALE_MS = 10_000;
/** 陈旧场景的不透明度，与"不确定 / 非实时"同为 50%（§3.2） */
export const STALE_OPACITY = 0.5;
/** 识别结果变化时交叉渐变的时长（ui.md §5.2、V-A9） */
export const FADE_MS = 600;
/** 立面沿墙脚线挤出的厚度 */
const WALL_THICKNESS_M = 0.2;
/** 黑板（D-059）：离地 0.9 m，比墙厚 4 cm，两面各凸出墙面 2 cm */
const BOARD_BASE_M = 0.9;
const BOARD_THICKNESS_M = 0.24;
/**
 * 地面色块与标线的高度：与栅格（0.005 m）相距 5 cm。深度缓冲精度可能很低（软件渲染实测 3 cm 仍会闪出栅格线），过近即争深度。
 * 色块不写深度，阴影与视场按绘制顺序叠在其上（PerceivedScene）
 */
const SURFACE_Y = 0.05;
const MARKING_Y = 0.055;

/** 环境类别色（§5.1 L1、V-S5）：两套分别取值，均为去饱和色，与状态色的色差 ΔE2000 ≥ 20 */
export interface Palette {
  road: string;
  sidewalk: string;
  floor: string;
  grass: string;
  earth: string;
  /** 立面、物体与树干 */
  facade: string;
  /** 立面顶盖：俯视时看清平面轮廓 */
  cap: string;
  /** 家具模型（D-059） */
  furniture: string;
  canopy: string;
  board: string;
  marking: string;
}
/** 地面类别低饱和；立面、物体与家具为中性灰实体，受光并投射阴影（ui.md §5.2、D-111） */
export const PALETTE: Record<Theme, Palette> = {
  dark: {
    road: "#40454C",
    sidewalk: "#2B2F34",
    floor: "#3E3B36",
    grass: "#283027",
    earth: "#342E26",
    facade: "#52525B",
    cap: "#71717A",
    furniture: "#A1A1AA",
    canopy: "#3F4A3C",
    board: "#27272A",
    marking: "#A1A1AA",
  },
};

/**
 * 渐变中一层的不透明度，k 为渐变进度 0～1：当前层由 0 淡入到 target；
 * 被取代的层从被取代时的不透明度 from 淡出到 0，连续到达多帧时正在淡入的层不先跳到不透明再淡出
 */
export function layerOpacity(target: number, k: number, from: number | null): number {
  return from === null ? target * k : from * (1 - k);
}

/** 识别环境去噪（V-A9）：简化容差（米）、丢弃过短的墙段与过小的地面块、视为未变化的最大偏移（米） */
const SIMPLIFY_M = 0.25;
const MIN_WALL_M = 0.6;
const MIN_SURFACE_M2 = 0.5;
export const SAME_SCENE_M = 0.3;

/** Douglas-Peucker 简化：去掉分割边缘的锯齿 */
const clean = (points: number[][]) =>
  simplify(
    points.map(([x = 0, y = 0]) => ({ x, y })),
    SIMPLIFY_M,
    true,
  ).map(({ x, y }) => [x, y]);

const length = (line: number[][]) =>
  line.slice(1).reduce((sum, [x = 0, y = 0], i) => sum + Math.hypot(x - (line[i]?.[0] ?? x), y - (line[i]?.[1] ?? y)), 0);

/** 识别帧去噪（V-A9）：分割结果原样挤出会出现锯齿尖刺；碎片丢弃 */
export function simplifyFrame(frame: SceneFrame): SceneFrame {
  const polygon = <T extends { polygon: number[][] }>(item: T) => ({ ...item, polygon: clean(item.polygon) });
  return {
    ...frame,
    surfaces: frame.surfaces.map(polygon).filter((s) => s.polygon.length >= 3 && area(s.polygon) >= MIN_SURFACE_M2),
    walls: frame.walls.map((w) => ({ ...w, line: clean(w.line) })).filter((w) => length(w.line) >= MIN_WALL_M),
    objects: frame.objects.map(polygon).filter((o) => o.polygon.length >= 3),
    markings: frame.markings.map(polygon).filter((m) => m.polygon.length >= 3),
  };
}

/** 点到折线（closed 为闭合多边形）的最短距离 */
function distance([px = 0, py = 0]: number[], line: number[][], closed: boolean): number {
  let best = Number.POSITIVE_INFINITY;
  const n = closed ? line.length : line.length - 1;
  for (let i = 0; i < Math.max(n, 1); i += 1) {
    const [ax = 0, ay = 0] = line[i] ?? [];
    const [bx = ax, by = ay] = line[(i + 1) % line.length] ?? [];
    const [dx, dy] = [bx - ax, by - ay];
    const k = dx === 0 && dy === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
    best = Math.min(best, Math.hypot(px - (ax + dx * k), py - (ay + dy * k)));
  }
  return best;
}

type Outline = { kind: string; points: number[][]; closed: boolean };

function shapes(frame: SceneFrame): Outline[] {
  return [
    ...frame.surfaces.map((s) => ({ kind: `s/${s.class}`, points: s.polygon, closed: true })),
    ...frame.walls.map((w) => ({ kind: `w/${w.class}`, points: w.line, closed: false })),
    ...frame.objects.map((o) => ({ kind: `o/${o.class}`, points: o.polygon, closed: true })),
    ...frame.markings.map((m) => ({ kind: "m", points: m.polygon, closed: true })),
    ...frame.trees.map((t) => ({ kind: "t", points: [[t.x, t.y]], closed: false })),
  ];
}

/** a 的每个顶点都在 b 中同类轮廓的 SAME_SCENE_M 以内 */
function covered(a: Outline[], b: Outline[]): boolean {
  return a.every(({ kind, points }) => {
    const near = b.filter((s) => s.kind === kind);
    return points.every((p) => near.some((s) => distance(p, s.points, s.closed) <= SAME_SCENE_M));
  });
}

/**
 * 两帧是否为同一场景（V-A9）：双向检查每个顶点都在另一帧同类轮廓的 0.3 m 以内。
 * 相同即沿用上一帧的几何体，不重建、不渐变；逐帧缓慢漂移累积超出 0.3 m 时才替换
 */
export function sameScene(a: SceneFrame, b: SceneFrame): boolean {
  const [sa, sb] = [shapes(a), shapes(b)];
  return covered(sa, sb) && covered(sb, sa);
}

export function isStale(frame: SceneFrame, now: number): boolean {
  return Date.parse(frame.ts) < now - STALE_MS;
}

/** 只渲染已标定、已登记摄像头的场景（V-U2） */
export function visibleScenes(scenes: Record<string, SceneFrame>, cameras: Camera[]): SceneFrame[] {
  const mapped = new Set(cameras.filter((c) => c.mapped).map((c) => c.id));
  return Object.values(scenes).filter((frame) => mapped.has(frame.camera_id));
}

/** 可见场景及是否陈旧：每秒按场景帧自带的 ts 重新判定，补推的旧帧到达即为陈旧（设计 §3.7） */
export function useScenes(cameras: Camera[]): { frame: SceneFrame; stale: boolean }[] {
  const scenes = useLive((s) => s.scenes);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return visibleScenes(scenes, cameras).map((frame) => ({ frame, stale: isStale(frame, now) }));
}

export function area(polygon: number[][]): number {
  let sum = 0;
  polygon.forEach(([x1 = 0, y1 = 0], i) => {
    const [x2 = 0, y2 = 0] = polygon[(i + 1) % polygon.length] ?? [];
    sum += x1 * y2 - x2 * y1;
  });
  return Math.abs(sum) / 2;
}

/** 地面多边形只取外轮廓，被包住的小块会与外层重叠：按面积从大到小绘制，小的盖在上面（设计 §3.3） */
export function largestFirst<T extends { polygon: number[][] }>(items: T[]): T[] {
  return [...items].sort((a, b) => area(b.polygon) - area(a.polygon));
}

/** 平面 (x, y) 落到地面 (x, 0, y)：形状按 (x, -y) 建立，绕 x 轴转 -90° 后法线朝上、挤出方向朝上 */
const shape = (polygon: number[][]) => new Shape(polygon.map(([x = 0, y = 0]) => new Vector2(x, -y)));
const upright = (geometry: BufferGeometry, y = 0) => geometry.rotateX(-Math.PI / 2).translate(0, y, 0);

/** 统一为非索引几何体并按顶点着色，各部件可合并为一次绘制 */
function paint(geometry: BufferGeometry, color: string): BufferGeometry {
  const flat = geometry.index ? geometry.toNonIndexed() : geometry;
  const { r, g, b } = new Color(color);
  const colors = new Float32Array(flat.getAttribute("position").count * 3);
  for (let i = 0; i < colors.length; i += 3) colors.set([r, g, b], i);
  return flat.setAttribute("color", new BufferAttribute(colors, 3));
}

/** 着色后把顶面（法线朝上的顶点）改为顶盖色 */
function paintCapped(geometry: BufferGeometry, side: string, cap: string): BufferGeometry {
  const painted = paint(geometry, side);
  const normal = painted.getAttribute("normal");
  const color = painted.getAttribute("color");
  const { r, g, b } = new Color(cap);
  for (let i = 0; i < normal.count; i += 1) if (normal.getY(i) > 0.5) color.setXYZ(i, r, g, b);
  return painted;
}

/** 材质不用贴图：去掉 uv，家具模型（无 uv）可与程序化几何体合并 */
const merge = (parts: BufferGeometry[]) =>
  parts.length === 0 ? null : mergeGeometries(parts.map((g) => g.deleteAttribute("uv")));

/** 按部件明度着色：顶点色（明度）乘以类别色 */
function tint(geometry: BufferGeometry, color: string): BufferGeometry {
  const { r, g, b } = new Color(color);
  const shade = geometry.getAttribute("color");
  for (let i = 0; i < shade.count; i += 1) shade.setXYZ(i, shade.getX(i) * r, shade.getY(i) * g, shade.getZ(i) * b);
  return geometry;
}

/** 家具模型（单位尺寸，useFurnitureModels）与该摄像头的平面位置：家具正面朝向摄像头（D-059） */
export interface Furnishing {
  models: Record<Furniture, BufferGeometry>;
  camera: [number, number];
}

/** 程序化低多边形树：树干 + 二十面体树冠（顶点最高处为半径的 0.85 倍，树冠顶即树高），按高度等比缩放，立在树干底部中心 */
function tree({ x, y, height_m }: SceneFrame["trees"][number], palette: Palette): BufferGeometry[] {
  return [
    paint(new CylinderGeometry(0.03, 0.04, 0.4, 6).translate(0, 0.2, 0), palette.facade),
    paint(new IcosahedronGeometry(0.35, 0).translate(0, 0.7, 0), palette.canopy),
  ].map((g) => g.scale(height_m, height_m, height_m).translate(x, 0, y));
}

/**
 * 一帧场景的几何体（§5.1 L1），每台摄像头两次绘制：
 * flat 为地面色块（面积从大到小）与路面标线，不受光照；solid 为立面、黑板、物体与树，受光照并投射阴影。
 * 桌、椅、柜、沙发、床以家具模型沿底面轮廓排开，其余物体由底面轮廓挤出（D-059）
 */
export function sceneGeometry(frame: SceneFrame, palette: Palette, furnishing: Furnishing) {
  const flat = [
    ...largestFirst(frame.surfaces).map((s) => paint(upright(new ShapeGeometry(shape(s.polygon)), SURFACE_Y), palette[s.class])),
    ...frame.markings.map((m) => paint(upright(new ShapeGeometry(shape(m.polygon)), MARKING_Y), palette.marking)),
  ];
  const walls = frame.walls.flatMap(({ class: kind, line, height_m }) => {
    const [base, thickness, color] =
      kind === "board" ? [BOARD_BASE_M, BOARD_THICKNESS_M, palette.board] : [0, WALL_THICKNESS_M, palette.facade];
    return line.slice(1).map((to, i) => {
      const [[x1 = 0, y1 = 0], [x2 = 0, y2 = 0]] = [line[i] ?? [], to];
      const box = new BoxGeometry(Math.hypot(x2 - x1, y2 - y1), height_m, thickness)
        .rotateY(-Math.atan2(y2 - y1, x2 - x1))
        .translate((x1 + x2) / 2, base + height_m / 2, (y1 + y2) / 2);
      return kind === "board" ? paint(box, color) : paintCapped(box, color, palette.cap);
    });
  });
  const objects = frame.objects.flatMap(({ class: kind, polygon, height_m }) =>
    isFurniture(kind)
      ? arrange(polygon, widthOf(kind), furnishing.camera).map(({ x, y, yaw, width, depth }) =>
          tint(furnishing.models[kind].clone().scale(width, height_m, depth).rotateY(yaw).translate(x, 0, y), palette.furniture),
        )
      : [paint(upright(new ExtrudeGeometry(shape(polygon), { depth: height_m, bevelEnabled: false })), palette.facade)],
  );
  const trees = frame.trees.flatMap((t) => tree(t, palette));
  return { flat: merge(flat), solid: merge([...walls, ...objects, ...trees]) };
}
export type SceneGeometry = ReturnType<typeof sceneGeometry>;
