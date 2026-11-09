import { expect, type Route, test } from "@playwright/test";
import {
  expectNoOverflow,
  freezeClock,
  mockKpis,
  mockSocket,
  SITE,
  sceneSettled,
  signedIn,
  UNAUTHORIZED,
} from "./helpers";

test.beforeEach(({ page }) => freezeClock(page));

test("主界面分区与空态", async ({ page }) => {
  await signedIn(page);
  await page.goto("/");

  await expect(page.getByText("演示办公区")).toBeVisible();
  await expect(page.getByRole("list", { name: "关键指标" }).getByText("—")).toHaveCount(4);
  await expect(page.getByText("暂无告警")).toBeVisible();
  // 处置时间线在详情中，未选中时主界面没有该区域
  await expect(page.getByRole("region", { name: "处置时间线" })).toHaveCount(0);
  await sceneSettled(page);
  await expectNoOverflow(page);
  await expect(page).toHaveScreenshot("shell.png");
});

test("关键指标显示数值与变化（D-100）", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 }); // 最窄的布局
  await signedIn(page);
  await mockKpis(page, {
    online_devices: { value: 2, delta: 0 },
    active_alerts: { value: 12, delta: 11 },
    contained_today: { value: 3, delta: 1 },
    last_contain_ms: { value: 18_400, delta: -2_600 },
  });
  await page.goto("/");

  const kpis = page.getByRole("list", { name: "关键指标" });
  await expect(kpis.getByTitle("较上一次")).toHaveText("↓ 2.6");
  await sceneSettled(page);
  // V-P3：最窄的 1366 宽下，指标卡一排完整显示，不与右侧告警卡重叠（设计 150 §3）
  const [row, side] = await Promise.all([kpis.boundingBox(), page.getByRole("complementary", { name: "告警与详情" }).boundingBox()]);
  expect((row?.x ?? 0) + (row?.width ?? 0)).toBeLessThan(side?.x ?? 0);
  await expectNoOverflow(page);
  await expect(kpis).toHaveScreenshot("kpis.png");
});

// 设计 150 §3、V-L2：场景铺满顶栏以下；指标卡下方、告警卡左侧不被卡片遮挡的部分占视口一半以上
for (const [width, height] of [
  [1920, 1080],
  [1366, 768],
] as const) {
  test(`场景铺满，卡片外的场景占比 ≥ 50%（${width}×${height}）`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await signedIn(page);
    await page.goto("/");

    const [scene, kpis, side] = await Promise.all([
      page.getByRole("region", { name: "场景" }).boundingBox(),
      page.getByRole("list", { name: "关键指标" }).boundingBox(),
      page.getByRole("complementary", { name: "告警与详情" }).boundingBox(),
    ]);
    if (!scene || !kpis || !side) throw new Error("主界面未就绪");
    expect(scene.width).toBe(width);
    const free = (side.x - scene.x) * (scene.y + scene.height - (kpis.y + kpis.height));
    expect(free / (width * height)).toBeGreaterThanOrEqual(0.5);
    await expectNoOverflow(page);
  });
}

test("退出登录后回到登录页", async ({ page }) => {
  let signedOut = false;
  await page.route("/api/site", (route) =>
    signedOut ? route.fulfill({ status: 401, json: UNAUTHORIZED }) : route.fulfill({ json: SITE }),
  );
  await mockSocket(page);
  await page.route("/api/auth/logout", (route) => {
    signedOut = true;
    return route.fulfill({ status: 204 });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "退出登录" }).click();

  await expect(page.getByRole("heading", { name: "欢迎回来" })).toBeVisible();
});

test("退出失败时停留在主界面并提示，请求期间按钮不可再点", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 }); // 顶栏最拥挤的情形
  await signedIn(page);
  let intercept: (route: Route) => void = () => {};
  const intercepted = new Promise<Route>((resolve) => (intercept = resolve));
  await page.route("/api/auth/logout", (route) => intercept(route));
  await page.goto("/");
  const button = page.getByRole("button", { name: "退出登录" });
  await button.click();

  await expect(button).toBeDisabled();
  await (await intercepted).fulfill({ status: 500, json: { ...UNAUTHORIZED, code: "internal_server_error" } });
  await expect(page.getByRole("alert")).toHaveText("退出失败，请重试");
  await expect(button).toBeEnabled();
  await expect(page.getByText("演示办公区")).toBeVisible();
  await expectNoOverflow(page);
  await expect(page.locator("header")).toHaveScreenshot("header-logout-failed.png");
});
