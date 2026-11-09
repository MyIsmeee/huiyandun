import { expect, type Page, type WebSocketRoute } from "@playwright/test";

/** 首次启动按 site.yaml 尺寸建的默认区域（设计 150 §5），尚未搭建 */
export const AREA = { id: "area-01", name: "默认区域", width_m: 40, depth_m: 24, items: [], updated_at: "2026-10-27T06:00:00Z" };

// 与 demo/scenarios/site.yaml 一致
export const SITE = {
  id: "demo-office",
  name: "演示办公区",
  width_m: 40,
  height_m: 24,
  areas: [AREA],
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

/** 降低动效开关（V-A4）；未调用时为 playwright.config.ts 预置的关闭 */
export async function presetMotion(page: Page, reducedMotion = false): Promise<void> {
  const state = JSON.stringify({ state: { reducedMotion }, version: 0 });
  await page.addInitScript((value) => localStorage.setItem("hyd-theme", value), state);
}

/**
 * 主画布视图（D-115）：默认监控墙。signedIn 与 open 预置为空间态势，供 3D 场景用例沿用；
 * 监控墙用例在其后再调用一次覆盖（后加入的初始化脚本后执行）。
 */
export async function presetView(page: Page, view: "wall" | "space", layout = "auto"): Promise<void> {
  const state = JSON.stringify({ state: { view, layout }, version: 0 });
  await page.addInitScript((value) => localStorage.setItem("hyd-wall", value), state);
}

/** 模拟 WS /ws：不连后端，连接即建立；按连接顺序记录服务端一侧，用例可借此推送或断开 */
export async function mockSocket(page: Page): Promise<WebSocketRoute[]> {
  const sockets: WebSocketRoute[] = [];
  await page.routeWebSocket("/ws", (ws) => void sockets.push(ws));
  return sockets;
}

/** 顶栏模型状态（V-M8）：第一家供应商生效 */
export async function mockLlmStatus(page: Page): Promise<void> {
  const status = { state: "normal", provider_name: "本地 llama.cpp", reason: null };
  await page.route("/api/llm/status", (route) => route.fulfill({ json: status }));
}

const NO_KPI = { value: null, delta: null };
const NO_KPIS = { online_devices: NO_KPI, active_alerts: NO_KPI, contained_today: NO_KPI, last_contain_ms: NO_KPI };

/** 大屏关键指标（D-100），缺省全部无数据 */
export async function mockKpis(page: Page, kpis: object = NO_KPIS): Promise<void> {
  await page.route(/\/api\/kpis\?/, (route) => route.fulfill({ json: kpis }));
}

export async function signedIn(page: Page): Promise<WebSocketRoute[]> {
  await presetView(page, "space");
  await page.route("/api/site", (route) => route.fulfill({ json: SITE }));
  await mockLlmStatus(page);
  await mockKpis(page);
  return mockSocket(page);
}

/** 模拟浏览器不支持 WebGL2：场景降级为 2D 俯视视图（C-FE-08），场景编辑不可用 */
export const withoutWebGL2 = (page: Page) =>
  page.addInitScript(() => {
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, id: string, ...rest: unknown[]) {
      return id === "webgl2" ? null : getContext.call(this, id, ...(rest as []));
    } as typeof getContext;
  });

/** 时钟固定在 Asia/Shanghai 14:30:00 并暂停，页面中的"最后更新"时刻确定；由用例以 clock.runFor 推进 */
export async function freezeClock(page: Page): Promise<void> {
  const now = new Date("2026-10-27T06:30:00Z");
  await page.clock.install({ time: new Date(now.getTime() - 1000) });
  await page.clock.pauseAt(now);
}

/** 等待顶部操作提示出现：提示经定时器挂载，时钟暂停时逐步推进直到出现（请求的响应按真实时间到达） */
export async function expectToast(page: Page, text: string): Promise<void> {
  await expect(async () => {
    await page.clock.runFor(100);
    await expect(page.getByText(text)).toBeVisible({ timeout: 50 });
  }).toPass({ intervals: [50] });
}

/** 等待场景到达指定状态；时钟已暂停时逐帧推进，使 3D 场景得以绘制首帧 */
export async function sceneSettled(page: Page, state: "ready" | "2d" | "error" = "ready"): Promise<void> {
  const scene = page.locator("[data-scene]");
  await expect(async () => {
    await page.clock.runFor(100);
    await expect(scene).toHaveAttribute("data-scene", state, { timeout: 50 });
  }).toPass({ intervals: [50] });
}

/** 位于默认区域中部的摄像头，状态由参数给定（设备与目标模型截图共用） */
export const camera = (state: string, id = "cam-01") => ({
  id,
  name: id,
  type: "camera",
  ip: "172.30.0.11",
  mode: "host_probe",
  state,
  alert_severity: null,
  camera: {
    stream: id,
    area_id: AREA.id,
    pose: { x: 16, y: 14, height_m: 3, yaw_deg: 300, pitch_deg: -30, hfov_deg: 90, range_m: 6 },
    // 4 组标定点即为已标定（FR-902），目标模型才会投放；外观状态由 state 给定
    calibration: [[312, 540, 14, 12], [980, 552, 18, 12], [450, 300, 14, 16], [870, 310, 18, 16]],
    mapping: "calibrated",
    homography: null,
    reproj_error_m: 0.3,
  },
});

/** 以给定设备打开主界面，返回模拟的 WS 服务端一侧 */
export async function open(page: Page, devices: object[]) {
  await presetView(page, "space");
  await page.route("/api/site", (route) => route.fulfill({ json: { ...SITE, devices } }));
  await mockLlmStatus(page);
  await mockKpis(page);
  const sockets = await mockSocket(page);
  await page.goto("/");
  // 先等场景代码与车辆模型加载完：加载按真实时间进行，期间 sceneSettled 逐帧推进的模拟时钟会随加载快慢漂移
  await page.waitForLoadState("networkidle");
  await sceneSettled(page);
  return sockets;
}

/** 放大到设备清晰可辨；放大后区域名称移出视口，文字溢出检查须在此之前（V-P3） */
/** 目标在场景区域内的像素位置（e2e 构建提供的 __hydTargetAt），用于点选与悬停 */
export async function targetAt(page: Page, key: string): Promise<{ x: number; y: number }> {
  const point = await page.evaluate((k) => window.__hydTargetAt?.(k) ?? null, key);
  if (!point) throw new Error(`场景中没有目标 ${key}`);
  return { x: Math.round(point[0]), y: Math.round(point[1]) };
}

export async function zoomIn(page: Page) {
  for (let i = 0; i < 3; i += 1) await page.getByRole("button", { name: "放大" }).click();
  await page.clock.runFor(600);
}
