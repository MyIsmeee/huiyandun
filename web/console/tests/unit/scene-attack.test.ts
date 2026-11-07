import { describe, expect, it } from "vitest";
import { attackerAnchor, OUTSIDE_M } from "../../src/scene/attack";

describe("attackerAnchor（D-076）", () => {
  it.each([
    [[2, 12], [-OUTSIDE_M, 12]], // 最近左边
    [[38, 12], [40 + OUTSIDE_M, 12]], // 最近右边
    [[20, 1], [20, -OUTSIDE_M]], // 最近上边
    [[20, 22], [20, 24 + OUTSIDE_M]], // 最近下边
  ] as const)("设备 %j 的攻击源在覆盖范围最近边缘外 %j", (device, anchor) => {
    expect(attackerAnchor(device, { x0: 0, y0: 0, width_m: 40, height_m: 24 })).toEqual(anchor);
  });

  it("覆盖范围不在原点时按其边缘取（D-116）", () => {
    expect(attackerAnchor([101, 55], { x0: 100, y0: 50, width_m: 20, height_m: 10 })).toEqual([100 - OUTSIDE_M, 55]);
  });
});
