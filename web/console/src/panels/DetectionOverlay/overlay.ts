import type { Target } from "../../store/live";

/** 实测超过此时长未更新即隐藏该目标的叠加（FR-107：与画面偏差不超过 300 ms） */
export const STALE_MS = 300;

/** COCO 17 点骨骼连线：头部、躯干、四肢 */
export const SKELETON: readonly (readonly [number, number])[] = [
  [0, 1], [0, 2], [1, 3], [2, 4],
  [5, 6], [11, 12], [5, 11], [6, 12],
  [5, 7], [7, 9], [6, 8], [8, 10],
  [11, 13], [13, 15], [12, 14], [14, 16],
];

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 视频按 object-contain 显示时画面在容器中的实际区域（V-W5：叠加须与画面对齐） */
export function contentRect(width: number, height: number, aspect: number): Rect {
  if (width <= 0 || height <= 0 || aspect <= 0) return { x: 0, y: 0, w: 0, h: 0 };
  if (width / height > aspect) {
    const w = height * aspect;
    return { x: (width - w) / 2, y: 0, w, h: height };
  }
  const h = width / aspect;
  return { x: 0, y: (height - h) / 2, w: width, h };
}

/** 画面归一化坐标 → 容器像素 */
export const toPixel = (u: number, v: number, rect: Rect): [number, number] => [rect.x + u * rect.w, rect.y + v * rect.h];

/** 最近一次实测在 STALE_MS 之内才画（断线或漏检时不留旧框） */
export function isFresh(target: Pick<Target, "trail">, now: number): boolean {
  const last = target.trail.at(-1)?.[2];
  return last !== undefined && now - last <= STALE_MS;
}

/** 点中的目标：取包含该点、面积最小的检测框（重叠时选前面较小的人），没有则 null */
export function hitTarget(point: [number, number], boxes: { key: string; bbox: number[] }[], rect: Rect): string | null {
  let best: { key: string; area: number } | null = null;
  for (const { key, bbox } of boxes) {
    const [x1 = 0, y1 = 0, x2 = 0, y2 = 0] = bbox;
    const [px1, py1] = toPixel(x1, y1, rect);
    const [px2, py2] = toPixel(x2, y2, rect);
    const inside = point[0] >= px1 && point[0] <= px2 && point[1] >= py1 && point[1] <= py2;
    const area = (px2 - px1) * (py2 - py1);
    if (inside && (!best || area < best.area)) best = { key, area };
  }
  return best?.key ?? null;
}
