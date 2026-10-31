import { describe, expect, it } from "vitest";
import { attackerAnchor, OUTSIDE_M } from "../../src/scene/attack";

describe("attackerAnchor（D-076）", () => {
  it.each([
    [[2, 12], [-OUTSIDE_M, 12]], // 最近左边
    [[38, 12], [40 + OUTSIDE_M, 12]], // 最近右边
    [[20, 1], [20, -OUTSIDE_M]], // 最近上边
    [[20, 22], [20, 24 + OUTSIDE_M]], // 最近下边
  ] as const)("设备 %j 的攻击源在最近站点边缘外 %j", (device, anchor) => {
    expect(attackerAnchor(device, 40, 24)).toEqual(anchor);
  });
});
