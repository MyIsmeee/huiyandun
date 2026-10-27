import { expect, test } from "@playwright/test";

// 组件全部状态的截图基线（V-G3、V-P2）；新增组件时在 gallery/main.tsx 登记并在此列出状态
const COMPONENTS = {
  KpiTile: ["normal", "empty", "loading", "stale"],
  FloorPlan2D: ["normal", "empty"],
};

for (const [component, states] of Object.entries(COMPONENTS)) {
  for (const state of states) {
    test(`${component}：${state}`, async ({ page }) => {
      await page.goto(`/tests/e2e/gallery/?component=${component}`);

      await expect(page.locator(`[data-state="${state}"]`)).toHaveScreenshot(`${component}-${state}.png`);
    });
  }
}
