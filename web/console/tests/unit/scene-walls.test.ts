import { describe, expect, it } from "vitest";
import { WALL_HEIGHT_M, WALL_THICKNESS_M } from "../../src/scene/layout";
import { DOOR_HEIGHT_M, isNearSide, wallPieces } from "../../src/scene/walls";

const HALF = WALL_THICKNESS_M / 2;
const round = (pieces: ReturnType<typeof wallPieces>) =>
  pieces.map((p) => ({
    from: p.from.map((v) => Math.round(v * 100) / 100),
    to: p.to.map((v) => Math.round(v * 100) / 100),
    bottom: p.bottom,
    top: p.top,
  }));

describe("wallPieces", () => {
  it("无门洞的墙体两端各延长半个墙厚，使转角闭合", () => {
    expect(round(wallPieces([[0, 0, 10, 0]], []))).toEqual([
      { from: [-HALF, 0], to: [10 + HALF, 0], bottom: 0, top: WALL_HEIGHT_M },
    ]);
  });

  it("门洞处断开，门洞上方留门楣", () => {
    expect(round(wallPieces([[0, 0, 10, 0]], [[4, 0, 6, 0]]))).toEqual([
      { from: [-HALF, 0], to: [4, 0], bottom: 0, top: WALL_HEIGHT_M },
      { from: [4, 0], to: [6, 0], bottom: DOOR_HEIGHT_M, top: WALL_HEIGHT_M },
      { from: [6, 0], to: [10 + HALF, 0], bottom: 0, top: WALL_HEIGHT_M },
    ]);
  });

  it("门洞方向与墙体相反、多个门洞乱序，结果一致", () => {
    const pieces = wallPieces(
      [[10, 0, 0, 0]],
      [
        [3, 0, 2, 0],
        [8, 0, 7, 0],
      ],
    );
    expect(pieces.filter((p) => p.bottom === DOOR_HEIGHT_M)).toHaveLength(2);
    expect(pieces.filter((p) => p.bottom === 0)).toHaveLength(3);
  });

  it("门洞只作用于其所在的墙体（允许 1 cm 偏差，FR-904）", () => {
    const pieces = wallPieces(
      [
        [0, 0, 10, 0],
        [0, 5, 10, 5],
      ],
      [[4, 0.005, 6, 0.005]],
    );
    expect(pieces.filter((p) => p.bottom === DOOR_HEIGHT_M)).toHaveLength(1);
    expect(pieces.filter((p) => p.from[1] === 5)).toHaveLength(1);
  });

  it("跳过长度为 0 的墙体", () => {
    expect(wallPieces([[5, 5, 5, 5]], [])).toEqual([]);
  });
});

describe("isNearSide", () => {
  // 相机位于 (+x, +z) 方向：40×24 站点的南墙（y = 24）与东墙（x = 40）在近侧
  const center = { width_m: 40, height_m: 24 };
  it.each([
    ["南墙", [0, 24, 40, 24], true],
    ["东墙", [40, 0, 40, 24], true],
    ["北墙", [0, 0, 40, 0], false],
    ["西墙", [0, 0, 0, 24], false],
  ])("%s", (_, wall, near) => {
    expect(isNearSide(wall, center)).toBe(near);
  });

  it("被门洞切开的墙段按整段墙体判断", () => {
    const pieces = wallPieces([[0, 24, 40, 24]], [[2, 24, 4, 24]]);
    expect(pieces.every((p) => isNearSide(p.wall, center))).toBe(true);
  });
});
