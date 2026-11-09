import { type Asset, type Footprint, footprints, type SceneItem } from "../scene/assets";

type Rot = SceneItem["rot"];
/** 预览占地与选中括框在重叠时的颜色（可放置时为强调色，设计 150 E-2、E-4） */
export const BLOCKED = "#94A3B8";
const EPS = 1e-6;

/** 资产按放置方向 rot 摆放后，沿平面 x、y 的占地（米）；方向只有 90° 的倍数，占地与坐标轴对齐 */
export function span(asset: Asset, rot: Rot): [number, number] {
  const [length, width] = asset.footprint;
  return rot % 180 === 0 ? [length, width] : [width, length];
}

/**
 * 指针所在的地面点吸附为放置点（设计 150 E-2）：占地边缘落在 1 m 网格上，整块留在区域内。
 * 线状资产先放一段，放置点为起点（设计 150 §5），长度取一段资产长度
 */
export function snap(asset: Asset, rot: Rot, [px, py]: [number, number], [width, depth]: [number, number]): SceneItem {
  const [sx, sy] = span(asset, rot);
  const fit = (p: number, size: number, max: number) => Math.min(Math.max(Math.round(p - size / 2), 0), Math.max(max - size, 0)) + size / 2;
  const [x, y] = [fit(px, sx, width), fit(py, sy, depth)];
  if (!asset.line) return { asset: asset.id, x, y, rot, len: null };
  const [length] = asset.footprint;
  const a = (rot * Math.PI) / 180;
  // 起点 = 中心沿放置方向后退半段；取整消除三角函数的浮点误差
  const back = (v: number) => Math.round(v * 1e6) / 1e6;
  return { asset: asset.id, x: back(x - (Math.cos(a) * length) / 2), y: back(y - (Math.sin(a) * length) / 2), rot, len: length };
}

/**
 * 地面层（道路、人行道与广场、草地）只与地面层互相占位：树种在草地上、桌椅摆在广场上不算重叠。
 * 目录没有单独的层级字段，按类别与编号判断
 */
export const onGround = (asset: Asset) => asset.category === "road" || asset.id === "grass";

function box({ x, y, length, width, rot }: Footprint): [number, number, number, number] {
  const [sx, sy] = rot % 180 === 0 ? [length, width] : [width, length];
  return [x - sx / 2, y - sy / 2, x + sx / 2, y + sy / 2];
}

/**
 * 线状资产按下 from、拖到 to（设计 150 E-3）：沿位移较大的坐标轴铺设，长度为资产长度的整数倍（至少一段）；
 * 起点为按下处最近的网格交点，资产宽为奇数格时中线让开半格，使边缘落在网格上
 */
export function stroke(asset: Asset, from: [number, number], to: [number, number]): SceneItem {
  const [length, width] = asset.footprint;
  const [ax, ay] = [Math.round(from[0]), Math.round(from[1])];
  const [dx, dy] = [to[0] - ax, to[1] - ay];
  const alongX = Math.abs(dx) >= Math.abs(dy);
  const rot: Rot = alongX ? (dx >= 0 ? 0 : 180) : dy >= 0 ? 90 : 270;
  const count = Math.max(1, Math.round(Math.abs(alongX ? dx : dy) / length));
  const half = width % 2 === 1 ? 0.5 : 0;
  return { asset: asset.id, x: alongX ? ax : ax + half, y: alongX ? ay + half : ay, rot, len: count * length };
}

/** 物体全部占地的外接矩形 [x0, y0, x1, y1]（线状资产合并各段） */
export function extent(item: SceneItem, catalog: Map<string, Asset>): [number, number, number, number] {
  const boxes = footprints([item], catalog).map(box);
  return [
    Math.min(...boxes.map((b) => b[0])),
    Math.min(...boxes.map((b) => b[1])),
    Math.max(...boxes.map((b) => b[2])),
    Math.max(...boxes.map((b) => b[3])),
  ];
}

/** 占地是否整块在区域内（线状资产逐段判断） */
export function inside(item: SceneItem, catalog: Map<string, Asset>, [width, depth]: [number, number]): boolean {
  return footprints([item], catalog).every((f) => {
    const [x0, y0, x1, y1] = box(f);
    return x0 > -EPS && y0 > -EPS && x1 < width + EPS && y1 < depth + EPS;
  });
}

/**
 * 旋转 90°（设计 150 E-4）：普通物体绕占地中心转，再吸附网格（长宽奇偶不同时中心挪半格）；线状资产绕起点转。
 * 转后超出区域时返回 null
 */
export function rotated(item: SceneItem, asset: Asset, catalog: Map<string, Asset>, size: [number, number]): SceneItem | null {
  const rot = ((item.rot + 90) % 360) as Rot;
  const next = asset.line ? { ...item, rot } : snap(asset, rot, [item.x, item.y], size);
  return inside(next, catalog, size) ? next : null;
}

/** 放下 item 是否与同一层已有物体的占地重叠（只接触边缘不算），重叠时禁止放置（设计 150 E-2）；except 为移动、旋转中的物体自身 */
export function overlaps(item: SceneItem, items: SceneItem[], catalog: Map<string, Asset>, except?: number): boolean {
  const placed = footprints(items.filter((_, i) => i !== except), catalog);
  return footprints([item], catalog).some((mine) => {
    const [ax0, ay0, ax1, ay1] = box(mine);
    return placed.some((other) => {
      if (onGround(other.asset) !== onGround(mine.asset)) return false;
      const [bx0, by0, bx1, by1] = box(other);
      return ax0 < bx1 - EPS && bx0 < ax1 - EPS && ay0 < by1 - EPS && by0 < ay1 - EPS;
    });
  });
}
