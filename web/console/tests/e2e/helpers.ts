import { expect, type Page } from "@playwright/test";

/** V-P3：截图前检查文字溢出——块级元素的内容宽度不得超出自身 */
export async function expectNoOverflow(page: Page): Promise<void> {
  const overflowing = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("body *")]
      .filter((el) => getComputedStyle(el).display !== "inline" && el.clientWidth > 0)
      .filter((el) => el.scrollWidth > el.clientWidth + 1)
      .map((el) => `${el.tagName.toLowerCase()}: ${el.textContent?.slice(0, 30)}`),
  );
  expect(overflowing).toEqual([]);
}

export async function presetTheme(page: Page, theme: "dark" | "light"): Promise<void> {
  const state = JSON.stringify({ state: { theme, reducedMotion: false }, version: 0 });
  await page.addInitScript((value) => localStorage.setItem("hyd-theme", value), state);
}
