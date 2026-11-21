import { describe, expect, it } from "vitest";
import {
  DIVE,
  diveAltitude,
  FINAL_ALTITUDE,
  forwardAngle,
  fovForRadius,
  hermite,
  CARD_WIDTH,
  cardRightGap,
  radiusForFov,
  REST_DISTANCE,
  restLayout,
  subsolarPoint,
} from "../../src/panels/LoginPage/globe/motion";

const TAU = Math.PI * 2;

describe("登录页地球 · 俯冲时间线", () => {
  it("目标角沿自转方向继续转过去，不倒转", () => {
    for (const from of [-7, -1, 0, 0.3, 5, 40]) {
      for (const target of [-3, 0, 1, 2.5]) {
        const to = forwardAngle(from, target);
        expect(to).toBeGreaterThanOrEqual(from - 1e-9);
        expect(to - from).toBeLessThan(TAU);
        expect(Math.abs((((to - target) % TAU) + TAU) % TAU)).toBeLessThan(1e-9);
      }
    }
    expect(forwardAngle(1, 1.2, 0.5)).toBeCloseTo(1.2 + TAU);
  });

  it("Hermite 从起点出发、停在终点，起步速度接上原有转速", () => {
    expect(hermite(1, 0.4, 3, 0)).toBe(1);
    expect(hermite(1, 0.4, 3, 1)).toBeCloseTo(3);
    const eps = 1e-4;
    expect((hermite(1, 0.4, 3, eps) - 1) / eps).toBeCloseTo(0.4, 2);
    expect((3 - hermite(1, 0.4, 3, 1 - eps)) / eps).toBeCloseTo(0, 2);
  });

  it("高度从静止距离单调降到终点高度，下降前后保持不动", () => {
    expect(diveAltitude(0)).toBeCloseTo(REST_DISTANCE - 1);
    expect(diveAltitude(DIVE.descend[0])).toBeCloseTo(REST_DISTANCE - 1);
    expect(diveAltitude(DIVE.total)).toBeCloseTo(FINAL_ALTITUDE);
    let last = Infinity;
    for (let t = 0; t <= DIVE.total; t += 0.05) {
      const h = diveAltitude(t);
      expect(h).toBeLessThanOrEqual(last + 1e-12);
      last = h;
    }
  });

  it("控制台在登录层开始淡出之前挂载，淡出在时间线结束时完成", () => {
    expect(DIVE.reveal).toBeLessThan(DIVE.fade[0]);
    expect(DIVE.fade[1]).toBe(DIVE.total);
    expect(DIVE.descend[1]).toBeLessThanOrEqual(DIVE.total);
  });
});

describe("登录页地球 · 布局", () => {
  it("宽屏时卡片按 Voyage 靠右，地球在卡片左侧居中，覆盖弧与卡片留出间距", () => {
    for (const [w, h] of [
      [1024, 700],
      [1440, 900],
      [1920, 1080],
      [2560, 1440],
    ] as const) {
      const { cx, cy, radius, split, cardLeft } = restLayout(w, h);
      expect(split).toBe(true);
      expect(cardLeft + CARD_WIDTH).toBeCloseTo(w - cardRightGap(w));
      expect(cx + radius * 1.22).toBeLessThanOrEqual(cardLeft - 47);
      expect(cy - radius * 1.22).toBeGreaterThanOrEqual(119);
      expect(cy + radius * 1.22).toBeLessThanOrEqual(h - 175);
    }
    expect(cardRightGap(1440)).toBeCloseTo(48 + 1440 * 0.08);
    expect(cardRightGap(1100)).toBeCloseTo(48 + 1100 * 0.04);
  });

  it("窄屏居中", () => {
    const { cx, cy, split } = restLayout(800, 900);
    expect(split).toBe(false);
    expect([cx, cy]).toEqual([400, 450]);
  });

  it("视场角与屏幕半径互为反函数", () => {
    const fov = fovForRadius(REST_DISTANCE, 260, 900);
    expect(radiusForFov(REST_DISTANCE, fov, 900)).toBeCloseTo(260);
  });

  it("太阳直射点：春分正午前后在赤道、本初子午线附近", () => {
    const { lat, lng } = subsolarPoint(new Date(Date.UTC(2026, 2, 20, 12, 7)));
    expect(Math.abs(lat)).toBeLessThan(0.02);
    expect(Math.abs(lng)).toBeLessThan(0.03);
  });
});
