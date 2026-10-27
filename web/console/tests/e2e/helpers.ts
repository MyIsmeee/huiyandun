import { expect, type Page, type WebSocketRoute } from "@playwright/test";

export const SITE = { id: "demo", name: "演示办公区", width_m: 40, height_m: 24, walls: [], zones: [], devices: [] };
export const UNAUTHORIZED = { code: "unauthorized", message: "未登录或会话失效", request_id: "r" };

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

/** 模拟 WS /ws：不连后端，连接即建立；按连接顺序记录服务端一侧，用例可借此推送或断开 */
export async function mockSocket(page: Page): Promise<WebSocketRoute[]> {
  const sockets: WebSocketRoute[] = [];
  await page.routeWebSocket("/ws", (ws) => void sockets.push(ws));
  return sockets;
}

export async function signedIn(page: Page): Promise<WebSocketRoute[]> {
  await page.route("/api/site", (route) => route.fulfill({ json: SITE }));
  return mockSocket(page);
}

/** 时钟固定在 Asia/Shanghai 14:30:00 并暂停，页面中的"最后更新"时刻确定；由用例以 clock.runFor 推进 */
export async function freezeClock(page: Page): Promise<void> {
  const now = new Date("2026-10-27T06:30:00Z");
  await page.clock.install({ time: new Date(now.getTime() - 1000) });
  await page.clock.pauseAt(now);
}
