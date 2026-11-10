import type { components } from "../api/schema";
import type { Asset, SceneItem } from "../scene/assets";
import type { CameraPlacement } from "./cameras";
import { inside, overlaps, snap, span, stroke } from "./placement";

/** 一台摄像头识别的环境，已投影到区域平面（米），不含图像；生成的类型把契约的 $defs 误当作字段，去掉 */
export type SceneFrame = Omit<components["schemas"]["scene_frame.schema"], "$defs">;
type Point = [number, number];
type Rot = SceneItem["rot"];

/** 识别类别 → 资产（设计 150 §7）；地板、泥地、黑板、其余家具与街道设施不转换 */
const TILES = [["road", "road"], ["sidewalk", "plaza"], ["grass", "grass"]] as const;
const WALLS: Record<string, string> = { wall: "wall", fence: "fence", railing: "fence" };
const OBJECTS: Record<string, string> = { table: "table", chair: "chair", cabinet: "cabinet", sofa: "sofa", bed: "bed" };
const MIN_SURFACE_M2 = 2;
const MIN_WALL_M = 1;
/** 识别把盆栽记为 1 m 高的矮树（vision-engine TREE_HEIGHT_M），低于此高度转为盆栽 */
const TREE_MIN_M = 3;
/** 地块一半以上被识别为该类别才铺；按 0.5 m 间隔取样估算 */
const COVER = 0.5;
const SAMPLE_M = 0.5;
/** 墙脚线外接矩形长边不小于短边的 1.5 倍即视为一段直墙，否则在离两端连线最远处折开 */
const STRAIGHT = 1.5;

const points = (list: number[][]): Point[] => list.map(([x = 0, y = 0]) => [x, y]);

/**
 * 用识别帧一次性生成场景草稿（FR-909，设计 150 §7）：地面按资产大小的网格栅格化，墙脚线拉直后按网格分段，
 * 建筑按墙脚线长度取最接近的建筑块、放在背向摄像头一侧，物体与树按中心吸附网格。
 * 只放在区域内，且不与 existing（页面上已有的物体，含未保存的）及先生成的草稿同层重叠
 */
export function draftFromFrames(
  frames: SceneFrame[],
  cameras: CameraPlacement[],
  size: [number, number],
  existing: SceneItem[],
  catalog: Map<string, Asset>,
): SceneItem[] {
  const draft: SceneItem[] = [];
  const add = (item: SceneItem | null) => {
    if (item && inside(item, catalog, size) && !overlaps(item, [...existing, ...draft], catalog)) draft.push(item);
  };
  const within = ([x, y]: Point) => x >= 0 && y >= 0 && x <= size[0] && y <= size[1];
  for (const frame of frames) {
    const camera = cameras.find((c) => c.id === frame.camera_id);
    for (const [name, id] of TILES) {
      const tile = catalog.get(id);
      const polygons = frame.surfaces.filter((s) => s.class === name).map((s) => points(s.polygon));
      if (tile) tiles(tile, polygons.filter((p) => area(p) >= MIN_SURFACE_M2), size).forEach(add);
    }
    for (const wall of frame.walls) {
      const line = points(wall.line);
      if (wall.class === "building" && camera) add(building(catalog, line, [camera.x, camera.y], size));
      const asset = catalog.get(WALLS[wall.class] ?? "");
      if (asset) for (const piece of straight(line)) add(wallItem(asset, piece, size, catalog));
    }
    for (const object of frame.objects) {
      const asset = catalog.get(OBJECTS[object.class] ?? "");
      const [x0, y0, x1, y1] = bounds(points(object.polygon));
      const center: Point = [(x0 + x1) / 2, (y0 + y1) / 2];
      if (!asset || !within(center)) continue;
      // 长边顺着识别出的底面
      add(snap(asset, y1 - y0 > x1 - x0 && asset.footprint[0] !== asset.footprint[1] ? 90 : 0, center, size));
    }
    for (const { x, y, height_m } of frame.trees) {
      const asset = catalog.get(height_m >= TREE_MIN_M ? "tree" : "potted-plant");
      if (asset && within([x, y])) add(snap(asset, 0, [x, y], size));
    }
  }
  return draft;
}

/** 地块资产铺满区域的网格中，被识别为该类别的格子；线状地块（道路）每格一段 */
function tiles(asset: Asset, polygons: Point[][], [width, depth]: [number, number]): SceneItem[] {
  const [s] = asset.footprint;
  const n = Math.round(s / SAMPLE_M);
  const covered = (i: number, j: number) => {
    let hits = 0;
    for (let a = 0; a < n; a += 1)
      for (let b = 0; b < n; b += 1) {
        const p: Point = [i * s + (a + 0.5) * SAMPLE_M, j * s + (b + 0.5) * SAMPLE_M];
        if (polygons.some((q) => contains(q, p))) hits += 1;
      }
    return hits >= COVER * n * n;
  };
  const cells = new Set<string>();
  for (const polygon of polygons) {
    const [x0, y0, x1, y1] = bounds(polygon);
    for (let i = Math.max(0, Math.floor(x0 / s)); i < Math.min(Math.floor(width / s), Math.ceil(x1 / s)); i += 1)
      for (let j = Math.max(0, Math.floor(y0 / s)); j < Math.min(Math.floor(depth / s), Math.ceil(y1 / s)); j += 1)
        if (covered(i, j)) cells.add(`${i},${j}`);
  }
  return [...cells].map((cell) => {
    const [i = 0, j = 0] = cell.split(",").map(Number);
    return asset.line
      ? { asset: asset.id, x: i * s, y: j * s + s / 2, rot: 0, len: s }
      : { asset: asset.id, x: i * s + s / 2, y: j * s + s / 2, rot: 0, len: null };
  });
}

/** 墙脚线拆成近似直线的几段：识别出的墙脚线沿墙面抖动，拐角处折开 */
function straight(line: Point[]): Point[][] {
  const [x0, y0, x1, y1] = bounds(line);
  const [ex, ey] = [x1 - x0, y1 - y0];
  const [a, b] = [line[0], line[line.length - 1]];
  if (!a || !b || line.length <= 2 || Math.max(ex, ey) >= STRAIGHT * Math.min(ex, ey)) return [line];
  const off = ([x, y]: Point) => Math.abs((b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]));
  let k = 1;
  line.forEach((p, i) => {
    if (i > 0 && i < line.length - 1 && off(p) > off(line[k] ?? a)) k = i;
  });
  return [...straight(line.slice(0, k + 1)), ...straight(line.slice(k))];
}

/** 一段墙脚线 → 沿较长坐标轴的墙或围栏，位于脚线的中位线上；超出区域的部分逐段去掉 */
function wallItem(asset: Asset, line: Point[], size: [number, number], catalog: Map<string, Asset>): SceneItem | null {
  const [x0, y0, x1, y1] = bounds(line);
  if (Math.max(x1 - x0, y1 - y0) < MIN_WALL_M) return null;
  const alongX = x1 - x0 >= y1 - y0;
  const clamp = ([x, y]: Point): Point => [Math.min(Math.max(x, 0), size[0]), Math.min(Math.max(y, 0), size[1])];
  const across = median(line.map((p) => p[alongX ? 1 : 0]));
  const item = stroke(asset, clamp(alongX ? [x0, across] : [across, y0]), clamp(alongX ? [x1, across] : [across, y1]));
  const [length] = asset.footprint;
  for (let len = item.len ?? length; len >= length; len -= length) if (inside({ ...item, len }, catalog, size)) return { ...item, len };
  return null;
}

/** 建筑：识别只见临街立面的墙脚线，取宽度最接近的建筑块，立面贴着脚线、楼身背向摄像头 */
function building(catalog: Map<string, Asset>, line: Point[], camera: Point, size: [number, number]): SceneItem | null {
  const [x0, y0, x1, y1] = bounds(line);
  const alongX = x1 - x0 >= y1 - y0;
  const [along, across] = alongX ? ([0, 1] as const) : ([1, 0] as const);
  const rot: Rot = alongX ? 0 : 90;
  const facade = Math.max(x1 - x0, y1 - y0);
  const front = median(line.map((p) => p[across]));
  const best = [...catalog.values()]
    .filter((a) => a.category === "building")
    .reduce<Asset | null>((a, b) => (a && Math.abs(span(a, rot)[along] - facade) <= Math.abs(span(b, rot)[along] - facade) ? a : b), null);
  if (!best || front < 0 || front > size[across]) return null;
  const back = front + ((front >= camera[across] ? 1 : -1) * span(best, rot)[across]) / 2;
  const middle = alongX ? (x0 + x1) / 2 : (y0 + y1) / 2;
  return snap(best, rot, alongX ? [middle, back] : [back, middle], size);
}

function bounds(list: Point[]): [number, number, number, number] {
  const xs = list.map((p) => p[0]);
  const ys = list.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function median(values: number[]): number {
  return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
}

/** 多边形面积（鞋带公式） */
function area(polygon: Point[]): number {
  const sum = polygon.reduce((acc, [x, y], i) => {
    const [nx, ny] = polygon[(i + 1) % polygon.length] ?? [x, y];
    return acc + x * ny - nx * y;
  }, 0);
  return Math.abs(sum) / 2;
}

/** 点是否在多边形内（射线法） */
function contains(polygon: Point[], [x, y]: Point): boolean {
  let hit = false;
  polygon.forEach(([xi, yi], i) => {
    const [xj, yj] = polygon[(i + polygon.length - 1) % polygon.length] ?? [xi, yi];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  });
  return hit;
}
