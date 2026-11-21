import { Euler, Matrix4, Quaternion, Vector3 } from "three";
import type { SceneFrame } from "../editor/recognition";
import type { Asset } from "./assets";

type SceneObject = SceneFrame["objects"][number];
type Point = readonly [number, number];

/**
 * 自动识别的电器、箱包与卫浴（scene_frame 的 appliance、box、fixture）按细分类别摆放模型库中的对应模型：
 * 显示器、电视、冰箱等形状特征明显，程序拼出的方块认不出是什么。桌、椅、柜、沙发、床仍按实测尺寸拼画（furniture.ts）。
 * 没有对应模型的（风扇、浴缸等）返回 null，同样按实测尺寸画方块
 */
export function modelFor(o: SceneObject): string | null {
  const height = o.height_m - (o.base_m ?? 0);
  switch (o.kind) {
    case "computer":
    case "crt_screen":
    case "monitor":
      return "monitor";
    case "television":
      return "tv";
    case "refrigerator":
      return height < 1.2 ? "fridge-small" : "fridge";
    case "washer":
      return "washer";
    case "microwave":
      return "microwave";
    case "oven":
    case "stove":
    case "dishwasher":
      return "kitchen-cabinet";
    case "lamp":
      return height >= 1 ? "lamp-floor" : "lamp-table";
    case "box":
      return "box";
    case "bag":
    case "basket":
      return "box-open";
    case "toilet":
      return "toilet";
    case "sink":
      return "bathroom-sink";
    case "shower":
      return "shower";
    default:
      break;
  }
  if (o.class === "box") return "box";
  if (o.class === "fixture") return "bathroom-sink";
  return null;
}

/**
 * 并排时连成一簇的模型（几台显示器、一摞纸箱）的单件宽度（米）：底面长边达到 1.5 倍即按长边排开多件，至多 ROW_MAX 件。
 * 其余（电视、冰箱等）一簇一件
 */
const WIDTH_M: Record<string, number> = { monitor: 0.55, box: 0.45, "box-open": 0.45 };
const ROW_MAX = 6;

/** 一簇摆几件 */
export function countOf(id: string, length: number): number {
  const w = WIDTH_M[id];
  return w && length >= 1.5 * w ? Math.min(ROW_MAX, Math.round(length / w)) : 1;
}

/** 底面多边形的中心、长边长度与转角（场景坐标：平面 (x, y) → (x, 0, y)；转角同 MeasuredScene 的 rect） */
function frame(polygon: number[][]): { center: Point; length: number; angle: number } {
  const p = polygon.map(([x = 0, y = 0]) => [x, y] as const);
  const center: Point = [p.reduce((s, q) => s + q[0], 0) / p.length, p.reduce((s, q) => s + q[1], 0) / p.length];
  const [a, b, c] = [p[0] ?? center, p[1] ?? center, p[2] ?? center];
  const e1 = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const e2 = Math.hypot(c[0] - b[0], c[1] - b[1]);
  const [from, to] = e1 >= e2 ? [a, b] : [b, c];
  return { center, length: Math.max(e1, e2), angle: -Math.atan2(to[1] - from[1], to[0] - from[0]) };
}

/**
 * 模型的放置矩阵：底面中心、底部离地 base_m（放在桌面上的显示器等），绕竖直轴转到底面长边，正面（+z）朝向识别它的
 * 摄像头一侧；按资产目录的比例换成米，不按实测尺寸拉伸（识别的底面是点云外接矩形，拉伸会把模型压扁）。
 * along：沿底面长边偏离中心的距离（米），排开多件时用
 */
export function placement(o: SceneObject, asset: Asset, eye?: Point, along = 0): Matrix4 {
  const { center: mid, angle: base } = frame(o.polygon);
  // 长边方向即绕竖直轴转 base 后的自身 x 轴：平面 (cos base, −sin base)
  const center: Point = [mid[0] + along * Math.cos(base), mid[1] - along * Math.sin(base)];
  const toward = eye ? (eye[0] - center[0]) * Math.sin(base) + (eye[1] - center[1]) * Math.cos(base) : 1;
  const angle = (toward < 0 ? base + Math.PI : base) - (asset.yaw * Math.PI) / 180;
  return new Matrix4().compose(
    new Vector3(center[0], o.base_m ?? 0, center[1]),
    new Quaternion().setFromEuler(new Euler(0, angle, 0)),
    new Vector3().setScalar(asset.scale),
  );
}

/** 各资产的放置矩阵；没有对应模型或目录中没有该资产的物体不在其中（由调用方按方块画）。并排连成一簇的按 countOf 排开 */
export function measuredModels(
  frames: SceneFrame[],
  catalog: Map<string, Asset>,
  eyes: Record<string, Point>,
): { groups: Map<string, Matrix4[]>; placed: Set<SceneObject> } {
  const groups = new Map<string, Matrix4[]>();
  const placed = new Set<SceneObject>();
  for (const f of frames)
    for (const o of f.objects) {
      const id = modelFor(o);
      const asset = id ? catalog.get(id) : undefined;
      if (!asset) continue;
      const { length } = frame(o.polygon);
      const n = countOf(asset.id, length);
      const eye = eyes[f.camera_id];
      const list = groups.get(asset.id) ?? [];
      for (let k = 0; k < n; k += 1) list.push(placement(o, asset, eye, (k + 0.5 - n / 2) * (length / n)));
      groups.set(asset.id, list);
      placed.add(o);
    }
  return { groups, placed };
}
