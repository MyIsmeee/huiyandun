import { describe, expect, it } from "vitest";
import { contentRect, hitTarget, isFresh, STALE_MS, toPixel } from "../../src/panels/DetectionOverlay/overlay";

describe("contentRect：object-contain 后画面的实际区域（V-W5）", () => {
  it("容器更宽：左右留黑边", () => {
    expect(contentRect(400, 100, 16 / 9)).toEqual({ x: (400 - 100 * (16 / 9)) / 2, y: 0, w: 100 * (16 / 9), h: 100 });
  });

  it("容器更高：上下留黑边", () => {
    expect(contentRect(160, 200, 16 / 9)).toEqual({ x: 0, y: (200 - 90) / 2, w: 160, h: 90 });
  });

  it("尺寸为 0 时不出现 NaN", () => {
    expect(contentRect(0, 0, 16 / 9)).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });

  it("归一化坐标换算到容器像素", () => {
    expect(toPixel(0.5, 1, { x: 10, y: 20, w: 160, h: 90 })).toEqual([90, 110]);
  });
});

describe("isFresh：超过 300 ms 未更新即不画（FR-107）", () => {
  it.each([
    [0, true],
    [STALE_MS, true],
    [STALE_MS + 1, false],
  ])("最近一次实测距今 %i ms → %s", (age, fresh) => {
    expect(isFresh({ trail: [[0, 0, 1000]] }, 1000 + age)).toBe(fresh);
  });

  it("没有实测不画", () => {
    expect(isFresh({ trail: [] }, 0)).toBe(false);
  });
});

describe("hitTarget：点中检测框（D-054）", () => {
  const rect = { x: 0, y: 0, w: 100, h: 100 };
  const boxes = [
    { key: "cam-01/1", bbox: [0.1, 0.1, 0.9, 0.9] },
    { key: "cam-01/2", bbox: [0.4, 0.4, 0.6, 0.6] },
  ];

  it("重叠时取面积较小的框（前面较小的人）", () => {
    expect(hitTarget([50, 50], boxes, rect)).toBe("cam-01/2");
    expect(hitTarget([20, 20], boxes, rect)).toBe("cam-01/1");
  });

  it("没点中任何框返回 null，点击交给瓦片选中设备", () => {
    expect(hitTarget([95, 95], boxes, rect)).toBeNull();
  });
});
