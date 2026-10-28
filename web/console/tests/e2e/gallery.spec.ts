import { expect, test } from "@playwright/test";

// 组件全部状态的截图基线（V-G3、V-P2）；新增组件时在 gallery/main.tsx 登记并在此列出状态
const COMPONENTS = {
  KpiTile: ["normal", "empty", "loading", "stale"],
  FloorPlan2D: ["normal", "empty"],
  LiveVideo: ["normal", "empty", "loading", "error", "disconnected"],
};

for (const [component, states] of Object.entries(COMPONENTS)) {
  for (const state of states) {
    test(`${component}：${state}`, async ({ page }) => {
      await page.goto(`/tests/e2e/gallery/?component=${component}`);
      // 视频须已有首帧，否则截到空白
      await page.waitForFunction(() => [...document.querySelectorAll("video")].every((v) => v.readyState >= 2));

      await expect(page.locator(`[data-state="${state}"]`)).toHaveScreenshot(`${component}-${state}.png`);
    });
  }
}
