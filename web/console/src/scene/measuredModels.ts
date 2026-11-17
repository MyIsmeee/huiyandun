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

/** 底面多边形的中心与长边转角（场景坐标：平面 (x, y) → (x, 0, y)；转角同 MeasuredScene 的 rect） */
function frame(polygon: number[][]): { center: Point; angle: number } {
  const p = polygon.map(([x = 0, y = 0]) => [x, y] as const);
  const center: Point = [p.reduce((s, q) => s + q[0], 0) / p.length, p.reduce((s, q) => s + q[1], 0) / p.length];
  const [a, b, c] = [p[0] ?? center, p[1] ?? center, p[2] ?? center];
  const e1 = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const e2 = Math.hypot(c[0] - b[0], c[1] - b[1]);
  const [from, to] = e1 >= e2 ? [a, b] : [b, c];
  return { center, angle: -Math.atan2(to[1] - from[1], to[0] - from[0]) };
}

/**
 * 模型的放置矩阵：底面中心、底部离地 base_m（放在桌面上的显示器等），绕竖直轴转到底面长边，正面（+z）朝向识别它的
 * 摄像头一侧；按资产目录的比例换成米，不按实测尺寸拉伸（识别的底面是点云外接矩形，拉伸会把模型压扁）
 */
export function placement(o: SceneObject, asset: Asset, eye?: Point): Matrix4 {
  const { center, angle: base } = frame(o.polygon);
  const toward = eye ? (eye[0] - center[0]) * Math.sin(base) + (eye[1] - center[1]) * Math.cos(base) : 1;
  const angle = (toward < 0 ? base + Math.PI : base) - (asset.yaw * Math.PI) / 180;
  return new Matrix4().compose(
    new Vector3(center[0], o.base_m ?? 0, center[1]),
    new Quaternion().setFromEuler(new Euler(0, angle, 0)),
    new Vector3().setScalar(asset.scale),
  );
}

/** 各资产的放置矩阵；没有对应模型或目录中没有该资产的物体不在其中（由调用方按方块画） */
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
      groups.set(asset.id, [...(groups.get(asset.id) ?? []), placement(o, asset, eyes[f.camera_id])]);
      placed.add(o);
    }
  return { groups, placed };
}
