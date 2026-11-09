import { use } from "react";
import { Euler, Matrix4, Quaternion, Vector3 } from "three";
import type { components } from "../api/schema";

export type SceneItem = components["schemas"]["SceneItem"];

/** 资产目录的一项（设计 150 §8）：由 tools/dev/assets.py 写出，与模型文件同源加载（G-05） */
export interface Asset {
  id: string;
  category: string;
  name: string;
  /** 所在 glb，场景名即 id */
  file: string;
  /** 占地格数 [x 向, z 向]，1 m 网格；已计入 yaw */
  footprint: [number, number];
  /** 模型单位换算为米 */
  scale: number;
  /** 先绕竖直轴转的角度（度），使线状资产长边沿 x */
  yaw: number;
  /** 线状资产：按 len 沿 x 向铺设 */
  line: boolean;
}

export const CATALOG_URL = "/models/catalog.json";

/**
 * 场景材质色（设计 150 §4，V-S5）：模型颜色已由 tools/dev/assets.py 按同一组色值烘焙进资产，
 * 这里供地面与 2D 俯视使用，并参与配色校验
 */
export const MATERIALS = {
  ground: "#EEF0F3",
  road: "#DCDFE5",
  plaza: "#E6E8EC",
  grass: "#DDE5DA",
  wall: "#FFFFFF",
  wallShade: "#E5E7EB",
  roof: "#CBD5E1",
  furniture: "#D4D4D8",
  canopy: "#B7C4B0",
} as const;

export interface Category {
  id: string;
  name: string;
}
let catalog: Promise<{ assets: Map<string, Asset>; categories: Category[] }> | null = null;

function loadCatalog() {
  catalog ??= fetch(CATALOG_URL).then(async (res) => {
    if (!res.ok) throw new Error(`资产目录加载失败：${res.status}`);
    const { assets, categories } = (await res.json()) as { assets: Asset[]; categories: Category[] };
    return { assets: new Map(assets.map((a) => [a.id, a])), categories };
  });
  return catalog;
}

/** 资产目录，按编号索引；首次调用时加载，加载期间挂起，失败由场景的错误边界显示"加载失败" */
export function useCatalog(): Map<string, Asset> {
  return use(loadCatalog()).assets;
}

/** 资产类别（场景页模型库），与目录同一次加载 */
export function useCategories(): Category[] {
  return use(loadCatalog()).categories;
}

/** 一件物体在平面上的占地：中心、沿放置方向的长与宽（米）、放置方向（度） */
export interface Footprint {
  asset: Asset;
  x: number;
  y: number;
  length: number;
  width: number;
  rot: number;
}

/**
 * 放置点的约定：普通物体 (x, y) 为占地中心；线状资产 (x, y) 为起点，沿放置方向铺 len 米，
 * 按资产长度分段（至少一段）。放置方向与摄像头朝向同一约定：0° 为平面 +x，增大时转向 +y。
 * 目录中没有的资产编号跳过（目录只增不改，正常不会出现）
 */
export function footprints(items: SceneItem[], assets: Map<string, Asset>): Footprint[] {
  return items.flatMap(({ asset: id, x, y, rot, len }) => {
    const asset = assets.get(id);
    if (!asset) return [];
    const [length, width] = asset.footprint;
    if (!asset.line) return [{ asset, x, y, length, width, rot }];
    const a = (rot * Math.PI) / 180;
    const count = Math.max(1, Math.round((len ?? length) / length));
    return Array.from({ length: count }, (_, k) => ({
      asset,
      x: x + Math.cos(a) * length * (k + 0.5),
      y: y + Math.sin(a) * length * (k + 0.5),
      length,
      width,
      rot,
    }));
  });
}

/** 按资产分组的实例矩阵：依次缩放、转 yaw、再转放置方向，平移到占地中心；平面 (x, y) 对应场景 (x, 0, y) */
export function instances(parts: Footprint[]): Map<string, Matrix4[]> {
  const groups = new Map<string, Matrix4[]>();
  for (const { asset, x, y, rot } of parts) {
    // three 绕 +y 的正转把 +x 转向 -z，即平面 -y：取反使放置方向转向平面 +y
    const turn = new Quaternion().setFromEuler(new Euler(0, (-(rot + asset.yaw) * Math.PI) / 180, 0));
    const matrix = new Matrix4().compose(new Vector3(x, 0, y), turn, new Vector3().setScalar(asset.scale));
    groups.set(asset.id, [...(groups.get(asset.id) ?? []), matrix]);
  }
  return groups;
}
