import { describe, expect, it } from "vitest";
import { lightingAt, lightStep } from "../../src/scene/lighting";

const at = (hhmm: string) => lightingAt(lightStep(new Date(`2026-10-27T${hhmm}:00`))); // 本地时间
const elevation = (hhmm: string) => at(hhmm).direction[1];

describe("场景光照（§5.1 光照、V-A6）", () => {
  it("按 10 分钟步进", () => {
    expect(lightStep(new Date("2026-10-27T14:30:00"))).toBe(14 * 60 + 30);
    expect(lightStep(new Date("2026-10-27T14:39:59"))).toBe(14 * 60 + 30);
    expect(lightStep(new Date("2026-10-27T14:40:00"))).toBe(14 * 60 + 40);
  });

  it("正午太阳最高，清晨与傍晚高度角低、阴影长", () => {
    expect(elevation("12:00")).toBeGreaterThan(elevation("09:00"));
    expect(elevation("09:00")).toBeGreaterThan(elevation("06:10"));
    expect(elevation("06:10")).toBeCloseTo(elevation("17:50"));
    expect(elevation("17:50")).toBeLessThan(0.2);
  });

  it("日出在东（+x），正午在南（+y），日落在西（-x）", () => {
    expect(at("06:10").direction[0]).toBeGreaterThan(0.9);
    expect(at("12:00").direction[2]).toBeGreaterThan(0);
    expect(Math.abs(at("12:00").direction[0])).toBeLessThan(1e-9);
    expect(at("17:50").direction[0]).toBeLessThan(-0.9);
  });

  it("18:00–06:00 为低强度月光，阴影更淡", () => {
    const [noon, night, dawn] = [at("12:00"), at("22:00"), at("05:50")];
    expect(night).toEqual(dawn);
    expect(night.sun + night.ambient).toBeLessThan(noon.sun + noon.ambient);
    expect(night.shadowOpacity).toBeLessThan(noon.shadowOpacity);
    expect(at("18:00")).toEqual(night);
  });

  it("光照方向为单位向量", () => {
    for (const hhmm of ["06:00", "09:30", "12:00", "17:50", "23:00"]) {
      expect(Math.hypot(...at(hhmm).direction)).toBeCloseTo(1);
    }
  });
});
