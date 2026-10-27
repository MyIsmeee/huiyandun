import type { Site } from "../lib/api";
import { WALL_HEIGHT_M, WALL_THICKNESS_M } from "./layout";

type Point = readonly [number, number];

/** 门洞净高，其上至墙顶为门楣 */
export const DOOR_HEIGHT_M = 2.1;
/** 门洞端点到墙体的允许偏差，与 api-server 导入校验一致（FR-904） */
const DOOR_TOLERANCE_M = 0.01;

/** 墙体的一段：平面图上的起止点与竖直方向的上下沿，单位米 */
export interface WallPiece {
  from: Point;
  to: Point;
  bottom: number;
  top: number;
  /** 所属墙体线段 */
  wall: number[];
}

/**
 * 按门洞把墙体切成实墙段与门楣段（§5.1 L1）。
 * 墙体两端各延长半个墙厚，使转角闭合；门洞只作用于其两端所在的那段墙体。
 */
export function wallPieces(walls: number[][], doors: number[][]): WallPiece[] {
  const pieces: WallPiece[] = [];
  for (const wall of walls) {
    const [x1 = 0, y1 = 0, x2 = 0, y2 = 0] = wall;
    const length = Math.hypot(x2 - x1, y2 - y1);
    if (length === 0) continue;
    const [ux, uy] = [(x2 - x1) / length, (y2 - y1) / length];
    const along = (x: number, y: number) => (x - x1) * ux + (y - y1) * uy;
    const off = (x: number, y: number) => Math.abs((x - x1) * uy - (y - y1) * ux);
    const onWall = (x: number, y: number) =>
      off(x, y) <= DOOR_TOLERANCE_M && along(x, y) >= -DOOR_TOLERANCE_M && along(x, y) <= length + DOOR_TOLERANCE_M;
    const at = (s: number): Point => [x1 + ux * s, y1 + uy * s];
    const solid = (s0: number, s1: number) => pieces.push({ from: at(s0), to: at(s1), bottom: 0, top: WALL_HEIGHT_M, wall });

    const gaps = doors
      .filter(([a = 0, b = 0, c = 0, d = 0]) => onWall(a, b) && onWall(c, d))
      .map(([a = 0, b = 0, c = 0, d = 0]) => [Math.min(along(a, b), along(c, d)), Math.max(along(a, b), along(c, d))])
      .sort(([a = 0], [b = 0]) => a - b);
    let s = -WALL_THICKNESS_M / 2;
    for (const [g0 = 0, g1 = 0] of gaps) {
      if (g0 > s) solid(s, g0);
      pieces.push({ from: at(g0), to: at(g1), bottom: DOOR_HEIGHT_M, top: WALL_HEIGHT_M, wall });
      s = Math.max(s, g1);
    }
    if (length + WALL_THICKNESS_M / 2 > s) solid(s, length + WALL_THICKNESS_M / 2);
  }
  return pieces;
}

/**
 * 是否为遮挡视线的近侧墙体：墙体中点位于站点中心朝相机的一侧（toCamera 为由站点指向相机的水平方向）。
 * 按整段墙体判断，同一墙体被门洞切开的各段结果一致。近侧墙体半透明，不遮挡室内（§5.1 L1）。
 */
export function isNearSide(
  [x1 = 0, y1 = 0, x2 = 0, y2 = 0]: number[],
  site: Pick<Site, "width_m" | "height_m">,
  [tx, ty]: readonly [number, number],
): boolean {
  const mx = (x1 + x2) / 2 - site.width_m / 2;
  const my = (y1 + y2) / 2 - site.height_m / 2;
  return mx * tx + my * ty > 0;
}
