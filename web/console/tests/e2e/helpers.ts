import { expect, type Page, type WebSocketRoute } from "@playwright/test";

// 与 demo/scenarios/site.yaml 一致
export const SITE = {
  id: "demo-office",
  name: "演示办公区",
  width_m: 40,
  height_m: 24,
  walls: [
    [0, 0, 40, 0],
    [40, 0, 40, 24],
    [40, 24, 0, 24],
    [0, 24, 0, 0],
  ],
  doors: [
    [18, 0, 20, 0],
    [0, 10, 0, 12],
  ],
  zones: [{ id: "z-01", name: "设备间外墙", polygon: [[30, 0], [40, 0], [40, 6], [30, 6]], no_climb: true }],
  devices: [],
};
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

/** 主题档位；未调用时为 playwright.config.ts 预置的暗色 */
export async function presetTheme(page: Page, mode: "auto" | "dark" | "light"): Promise<void> {
  const state = JSON.stringify({ state: { mode, reducedMotion: false }, version: 0 });
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

/** 等待场景到达指定状态；时钟已暂停时逐帧推进，使 3D 场景得以绘制首帧 */
export async function sceneSettled(page: Page, state: "ready" | "2d" | "error" = "ready"): Promise<void> {
  const scene = page.locator("[data-scene]");
  await expect(async () => {
    await page.clock.runFor(100);
    await expect(scene).toHaveAttribute("data-scene", state, { timeout: 50 });
  }).toPass({ intervals: [50] });
}

/** 位于站点中部的摄像头，状态由参数给定（设备与人员化身截图共用） */
export const camera = (state: string, id = "cam-01") => ({
  id,
  type: "camera",
  ip: "172.30.0.11",
  mode: "host_probe",
  state,
  alert_severity: null,
  camera: {
    stream: id,
    pose: { x: 16, y: 14, height_m: 3, yaw_deg: 300, pitch_deg: -30, hfov_deg: 90, range_m: 6 },
    // 4 组标定点即为已标定（FR-902），人员化身才会投放；外观状态由 state 给定
    calibration: [[312, 540, 14, 12], [980, 552, 18, 12], [450, 300, 14, 16], [870, 310, 18, 16]],
    homography: null,
    reproj_error_m: 0.3,
  },
});

/** 以给定设备打开主界面，返回模拟的 WS 服务端一侧 */
export async function open(page: Page, devices: object[]) {
  await page.route("/api/site", (route) => route.fulfill({ json: { ...SITE, devices } }));
  const sockets = await mockSocket(page);
  await page.goto("/");
  await sceneSettled(page);
  return sockets;
}

/** 放大到设备清晰可辨；放大后区域名称移出视口，文字溢出检查须在此之前（V-P3） */
export async function zoomIn(page: Page) {
  for (let i = 0; i < 3; i += 1) await page.getByRole("button", { name: "放大" }).click();
  await page.clock.runFor(600);
}
