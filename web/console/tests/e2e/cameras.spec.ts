import { expect, type Page, test } from "@playwright/test";
import { expectNoOverflow, openAdmin, signedIn } from "./helpers";

const POSE = { x: 2, y: 2, height_m: 3, yaw_deg: 45, pitch_deg: -30, hfov_deg: 90, range_m: 15 };
const CAMERA = {
  id: "cam-03", name: "大门口", ip: "192.168.8.31", ingest: "pull",
  source: { protocol: "rtsp", host: "192.168.8.31", port: 554, path: "/Streaming/Channels/101", relay: false },
  username: "admin", password_set: true, pose: POSE, calibration: [], calibration_error_m: null, climb_lines: [],
  created_at: "2026-11-05T00:00:00Z", updated_at: "2026-11-05T00:00:00Z",
}; // prettier-ignore
const PUSHED = { ...CAMERA, id: "cam-04", name: "仓库", ip: "192.168.8.32", ingest: "push", source: null, password_set: false };

async function openCameras(page: Page, items: unknown[]): Promise<void> {
  await signedIn(page);
  await page.route("/api/auth/session", (route) => route.fulfill({ json: { username: "admin", role: "admin", expires_at: "2026-11-08T00:00:00Z" } }));
  await page.route("/api/cameras", (route) => route.fulfill({ json: { items } }));
  await page.goto("/");
  await openAdmin(page, "摄像头");
}

// 摄像头页（ui.md §7.2）：列表与空态的截图基线（V-P2、V-G3）
test("摄像头列表：拉流与推流各一路", async ({ page }) => {
  await openCameras(page, [CAMERA, PUSHED]);
  await expect(page.getByRole("table", { name: "摄像头列表" }).getByRole("row")).toHaveCount(3);
  await expectNoOverflow(page);
  await expect(page).toHaveScreenshot("cameras.png");
});

test("摄像头列表：空态", async ({ page }) => {
  await openCameras(page, []);
  await expect(page.getByText("还没有摄像头")).toBeVisible();
  await expectNoOverflow(page);
  await expect(page).toHaveScreenshot("cameras-empty.png");
});

// 管理页外框（设计 150 §9A）：顶栏"管理"进入，左侧栏切换管理页，可收起为图标栏
test("管理页侧栏：切换页面、标示当前项、收起为图标栏", async ({ page }) => {
  await page.route("/api/llm/providers", (route) => route.fulfill({ json: { items: [] } }));
  await page.route("/api/llm/settings", (route) => route.fulfill({ json: { block_public: false } }));
  await openCameras(page, [CAMERA]);
  const sidebar = page.getByRole("navigation", { name: "管理" });
  await expect(page.getByRole("navigation", { name: "导航" }).getByRole("button", { name: "管理" })).toHaveAttribute("aria-current", "page");
  await expect(sidebar.getByRole("button", { name: "摄像头" })).toHaveAttribute("aria-current", "page");

  await sidebar.getByRole("button", { name: "模型供应商" }).click();
  await expect(page.getByRole("region", { name: "模型供应商" })).toBeVisible();
  await expect(page.getByRole("region", { name: "摄像头" })).toHaveCount(0);

  await page.getByRole("button", { name: "收起或展开侧栏" }).click();
  await expect(sidebar.getByText("模型供应商")).toBeHidden();
  await expectNoOverflow(page);
  await expect(page).toHaveScreenshot("admin-sidebar-collapsed.png");

  await page.getByRole("navigation", { name: "导航" }).getByRole("button", { name: "态势" }).click();
  await expect(sidebar).toHaveCount(0);
});

test("管理页盖在监控墙之上时，返回回到监控墙", async ({ page }) => {
  await openCameras(page, [CAMERA]);
  const nav = page.getByRole("navigation", { name: "导航" });
  await nav.getByRole("button", { name: "监控墙" }).click();
  await nav.getByRole("button", { name: "管理" }).click();
  await page.getByRole("region", { name: "摄像头" }).getByRole("button", { name: "返回" }).click();
  await expect(nav.getByRole("button", { name: "监控墙" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("navigation", { name: "管理" })).toHaveCount(0);
});

/** 充当截帧的 1280×720 灰色图片：浏览器按内容识别格式 */
const FRAME = '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"><rect width="1280" height="720" fill="#888"/></svg>';
const POINTS = [
  [128, 648, 4, 21.6], [1152, 648, 36, 21.6], [384, 432, 12, 12],
  [896, 432, 28, 12], [512, 324, 16, 4.8], [768, 324, 24, 4.8],
]; // prettier-ignore

/** 服务端的错误应答（契约 Error） */
const failure = (status: number, message: string) => ({ status, json: { code: String(status), message, request_id: "req-e2e" } });

/** 打开编辑框里的标定对话框；截帧、拟合与保存由服务端应答，此处拦截，fail 指定其中失败的一项。返回对话框 */
async function openCalibration(page: Page, calibration: number[][], fail: { snapshot?: string; check?: [number, string] } = {}) {
  // 点满 6 组时对话框不出现滚动条
  await page.setViewportSize({ width: 1440, height: 1000 });
  let camera: object = { ...CAMERA, area_id: "area-01", calibration, calibration_error_m: calibration.length ? 0.21 : null };
  await page.route(/\/api\/cameras\/cam-03\/snapshot$/, (route) =>
    route.fulfill(fail.snapshot ? failure(502, fail.snapshot) : { contentType: "image/svg+xml", body: FRAME }),
  );
  await page.route(/\/calibration\/check$/, (route) => {
    if (fail.check) return route.fulfill(failure(...fail.check));
    const { points } = route.request().postDataJSON() as { points: unknown[] };
    return route.fulfill({ json: { reproj_error_m: 0.21, residuals_m: points.map((_, i) => 0.1 + i * 0.03) } });
  });
  await page.route(/\/calibration$/, (route) => {
    camera = { ...camera, calibration: (route.request().postDataJSON() as { points: unknown[] }).points, calibration_error_m: 0.21 };
    return route.fulfill({ json: camera });
  });
  await signedIn(page);
  await page.route("/api/auth/session", (route) => route.fulfill({ json: { username: "admin", role: "admin", expires_at: "2026-11-08T00:00:00Z" } }));
  await page.route("/api/cameras", (route) => route.fulfill({ json: { items: [camera] } }));
  await page.goto("/");
  await openAdmin(page, "摄像头");
  await page.getByRole("button", { name: "编辑 大门口" }).click();
  await page.getByRole("region", { name: "地面映射" }).getByRole("button", { name: "标定" }).click();
  return page.getByRole("dialog", { name: "地面标定 cam-03 · 默认区域" });
}

// 地面标定（V-CAM10、FR-910，A19）：编辑框进入，点 6 组后保存，编辑框与列表显示误差
test("地面标定：点 6 组后保存，列表显示已标定与误差", async ({ page }) => {
  const dialog = await openCalibration(page, []);
  const frame = dialog.getByAltText("标定画面");
  const plan = dialog.getByRole("img", { name: "区域俯视图" });
  const [fw, fh] = await frame.evaluate((img: HTMLImageElement) => [img.clientWidth, img.clientHeight]);
  const [pw, ph] = await plan.evaluate((svg) => [svg.clientWidth, svg.clientHeight]);
  for (const [u, v, x, y] of POINTS) {
    await frame.click({ position: { x: ((u ?? 0) / 1280) * fw, y: ((v ?? 0) / 720) * fh } });
    await plan.click({ position: { x: ((x ?? 0) / 40) * pw, y: ((y ?? 0) / 24) * ph } });
  }
  await expect(dialog.getByRole("table", { name: "标定点" }).getByRole("row")).toHaveCount(7);
  await expect(dialog.getByRole("status")).toHaveText("均方根误差 0.21 m");

  await dialog.getByRole("button", { name: "保存" }).click();
  await expect(page.getByText("已保存标定")).toBeVisible();
  await expect(page.getByRole("region", { name: "地面映射" })).toContainText("已标定 · 误差 ±0.21 m");
  await page.getByRole("button", { name: "关闭" }).first().click();
  await expect(page.getByRole("table", { name: "摄像头列表" })).toContainText("已标定 · 误差 ±0.21 m");
});

// 截图基线（V-P3、V-G3）：已标定的摄像头打开时载入已有的点并检查，点位固定、截图稳定
test("地面标定：已标定时载入已有的点与各组偏差", async ({ page }) => {
  const dialog = await openCalibration(page, POINTS);
  await expect(dialog.getByRole("status")).toHaveText("均方根误差 0.21 m");
  await expect(dialog.getByRole("button", { name: "清除标定" })).toBeVisible();
  await page.mouse.move(0, 0);
  await expectNoOverflow(page);
  await expect(dialog).toHaveScreenshot("calibration-dialog.png");
});

// 其余状态的截图基线（V-G3）：空、取不到画面、拟合失败、识别服务未响应
for (const [name, calibration, fail, text] of [
  ["empty", [], {}, "还差 4 组"],
  ["no-frame", [], { snapshot: "取画面超时：摄像头无响应或网络不通" }, "取不到画面：取画面超时：摄像头无响应或网络不通"],
  ["fit-failed", POINTS, { check: [400, "这些点对不上：检查每组画面点与地面点是否对应，画面点是否点在地面上"] }, "这些点对不上"],
  ["unavailable", POINTS, { check: [503, "识别服务未响应，请稍后重试"] }, "识别服务未响应，请稍后重试"],
] as const) {
  test(`地面标定状态：${name}`, async ({ page }) => {
    const dialog = await openCalibration(page, [...calibration], fail as { snapshot?: string; check?: [number, string] });
    await expect(dialog).toContainText(text);
    await expect(dialog.getByRole("button", { name: "保存" })).toBeDisabled();
    await page.mouse.move(0, 0);
    await expectNoOverflow(page);
    await expect(dialog).toHaveScreenshot(`calibration-dialog-${name}.png`);
  });
}
