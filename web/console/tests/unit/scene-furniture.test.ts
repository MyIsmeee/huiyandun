import { describe, expect, it } from "vitest";
import { arrange } from "../../src/scene/furniture";

/** 平面上的矩形底面：x0～x1 × y0～y1 */
const rect = (x0: number, y0: number, x1: number, y1: number) => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
];

describe("arrange（D-059）", () => {
  it("连成一片的同类家具按标准宽度等距排开，均分识别长度", () => {
    const placements = arrange(rect(0, 0, 3.6, 0.6), 1.2, [1.8, -5]);

    expect(placements.map((p) => p.x)).toEqual([0.6, 1.8, 3].map((x) => expect.closeTo(x)));
    for (const p of placements) {
      expect(p.y).toBeCloseTo(0.3);
      expect(p.width).toBeCloseTo(1.2);
      expect(p.depth).toBeCloseTo(0.6);
    }
  });

  it("张数按长度四舍五入，至少一件；每件宽度取均分后的长度", () => {
    expect(arrange(rect(0, 0, 4, 0.6), 1.2, [0, -5]).map((p) => p.width)).toEqual([1, 1, 1].map((w) => expect.closeTo(w + 1 / 3)));
    const [single, ...rest] = arrange(rect(0, 0, 0.5, 0.6), 1.2, [0, -5]);

    expect(rest).toEqual([]);
    expect(single?.width).toBeCloseTo(0.6); // 区域比宽深还窄时沿较长的一边
    expect(single?.depth).toBeCloseTo(0.5);
  });

  it("正面朝向摄像头一侧", () => {
    // 局部 +z 为正面，yaw 为绕竖直轴转角：正面方向 (sin yaw, cos yaw) 对应平面 (x, y)
    const front = (yaw: number) => [Math.sin(yaw), Math.cos(yaw)].map((v) => Math.round(v) + 0); // + 0 把 -0 归为 0

    expect(front(arrange(rect(0, 0, 3.6, 0.6), 1.2, [1.8, -5])[0]?.yaw ?? NaN)).toEqual([0, -1]);
    expect(front(arrange(rect(0, 0, 3.6, 0.6), 1.2, [1.8, 9])[0]?.yaw ?? NaN)).toEqual([0, 1]);
  });

  it("斜放的区域沿其长边排开", () => {
    const c = Math.SQRT1_2;
    // 沿 (1, 1) 方向长 2.4 m、宽 0.6 m 的斜矩形
    const polygon = [
      [0, 0],
      [2.4 * c, 2.4 * c],
      [2.4 * c - 0.6 * c, 2.4 * c + 0.6 * c],
      [-0.6 * c, 0.6 * c],
    ];
    const placements = arrange(polygon, 1.2, [5, -5]);

    expect(placements).toHaveLength(2);
    const [a, b] = placements;
    expect((b?.x ?? 0) - (a?.x ?? 0)).toBeCloseTo(1.2 * c);
    expect((b?.y ?? 0) - (a?.y ?? 0)).toBeCloseTo(1.2 * c);
    expect(Math.sin(a?.yaw ?? 0)).toBeCloseTo(c); // 摄像头在右下方：正面朝 (1, -1)
    expect(Math.cos(a?.yaw ?? 0)).toBeCloseTo(-c);
  });
});
