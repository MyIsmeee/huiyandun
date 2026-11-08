/** 监控墙宫格布局（ui.md V-W1）：自动、1、4、9、1+5 */
export type WallLayout = "auto" | "1" | "4" | "9" | "1+5";

export interface Grid {
  cols: number;
  rows: number;
  /** 每页容纳的路数 */
  capacity: number;
  /** 1+5：第一格占 2×2 */
  featured: boolean;
  /** 固定布局：不足一页时显示空位 */
  fixed: boolean;
}

/** 自动布局每页最多 4×4 */
const AUTO_MAX = 16;

export function wallGrid(count: number, layout: WallLayout): Grid {
  switch (layout) {
    case "1":
      return { cols: 1, rows: 1, capacity: 1, featured: false, fixed: true };
    case "4":
      return { cols: 2, rows: 2, capacity: 4, featured: false, fixed: true };
    case "9":
      return { cols: 3, rows: 3, capacity: 9, featured: false, fixed: true };
    case "1+5":
      return { cols: 3, rows: 3, capacity: 6, featured: true, fixed: true };
    case "auto": {
      // n 路取列数 ceil(√n)、行数 ceil(n / 列数)；超过 16 路按 4×4 分页
      const n = Math.min(Math.max(count, 1), AUTO_MAX);
      const cols = Math.ceil(Math.sqrt(n));
      return { cols, rows: Math.ceil(n / cols), capacity: n, featured: false, fixed: false };
    }
  }
}

export const pageCount = (count: number, grid: Grid) => Math.max(1, Math.ceil(count / grid.capacity));

/**
 * 格子尺寸：每格保持 16:9，整体在画布内居中；gap 为格间距与四周留白。
 * 返回单格宽高（1+5 的大格为其 2 倍加一个间距）。
 */
export function tileSize(width: number, height: number, grid: Grid, gap: number): { w: number; h: number } {
  const byWidth = (width - gap * (grid.cols + 1)) / grid.cols;
  const byHeight = ((height - gap * (grid.rows + 1)) / grid.rows) * (16 / 9);
  const w = Math.max(0, Math.floor(Math.min(byWidth, byHeight)));
  return { w, h: Math.floor((w * 9) / 16) };
}

/**
 * 当前页显示的摄像头：1+5 时选中的摄像头放在大格（未选中时为第一台），其余按登记顺序（V-L1 不按告警重排）。
 * 固定布局不足一页的格子以 null 表示空位（显示虚线空位）；自动布局不补空位。
 */
export function pageItems<T extends { id: string }>(items: T[], grid: Grid, page: number, featuredId: string | null): (T | null)[] {
  let ordered = items;
  if (grid.featured && featuredId) {
    const hit = items.find((i) => i.id === featuredId);
    if (hit) ordered = [hit, ...items.filter((i) => i !== hit)];
  }
  const slice: (T | null)[] = ordered.slice(page * grid.capacity, (page + 1) * grid.capacity);
  if (grid.fixed) while (slice.length < grid.capacity) slice.push(null);
  return slice;
}

/** 某台摄像头所在的页码；不在列表中返回 null */
export function pageOf<T extends { id: string }>(items: T[], grid: Grid, id: string, featuredId: string | null): number | null {
  const pages = pageCount(items.length, grid);
  for (let p = 0; p < pages; p++) if (pageItems(items, grid, p, featuredId).some((i) => i?.id === id)) return p;
  return null;
}
