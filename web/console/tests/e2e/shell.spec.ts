import { expect, type Route, test } from "@playwright/test";
import { expectNoOverflow, freezeClock, mockSocket, presetTheme, SITE, signedIn, UNAUTHORIZED } from "./helpers";

test.beforeEach(({ page }) => freezeClock(page));

for (const theme of ["dark", "light"] as const) {
  test(`主界面分区与空态（${theme}）`, async ({ page }) => {
    await presetTheme(page, theme);
    await signedIn(page);
    await page.goto("/");

    await expect(page.getByText("演示办公区")).toBeVisible();
    await expect(page.getByRole("list", { name: "关键指标" }).getByText("—")).toHaveCount(4);
    await expect(page.getByText("无活跃攻击链")).toBeVisible();
    await expect(page.getByText("暂无告警")).toBeVisible();
    await expectNoOverflow(page);
    await expect(page).toHaveScreenshot(`shell-${theme}.png`);
  });
}

// V-L2：场景视口是面积最大的单一元素，占比 ≥ 50%
for (const [width, height] of [
  [1920, 1080],
  [1366, 768],
] as const) {
  test(`场景视口占比 ≥ 50%（${width}×${height}）`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await signedIn(page);
    await page.goto("/");

    const box = await page.getByRole("region", { name: "场景" }).boundingBox();
    expect(box).not.toBeNull();
    expect(((box?.width ?? 0) * (box?.height ?? 0)) / (width * height)).toBeGreaterThanOrEqual(0.5);
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
