import { expect, type Page, test } from "@playwright/test";
import { expectNoOverflow, presetTheme } from "./helpers";

const SITE = { id: "demo", name: "演示办公区", width_m: 40, height_m: 24, walls: [], zones: [], devices: [] };
const UNAUTHORIZED = { code: "unauthorized", message: "未登录或会话失效", request_id: "r" };

async function signedOut(page: Page) {
  await page.route("/api/site", (route) => route.fulfill({ status: 401, json: UNAUTHORIZED }));
}

async function fill(page: Page) {
  await page.getByLabel("用户名").fill("viewer");
  await page.getByLabel("密码", { exact: true }).fill("secret");
}

for (const theme of ["dark", "light"] as const) {
  test(`未登录时显示登录页（${theme}）`, async ({ page }) => {
    await presetTheme(page, theme);
    await signedOut(page);
    await page.goto("/");

    await expect(page.getByRole("heading", { name: "欢迎回来" })).toBeVisible();
    await expectNoOverflow(page);
    await expect(page).toHaveScreenshot(`login-${theme}.png`);
  });
}

test("窄屏只保留表单", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 900 });
  await signedOut(page);
  await page.goto("/");

  await expect(page.getByText("一屏联动")).toBeHidden();
  await expectNoOverflow(page);
  await expect(page).toHaveScreenshot("login-narrow.png");
});

test("密码错误时提示原因", async ({ page }) => {
  await signedOut(page);
  await page.route("/api/auth/login", (route) =>
    route.fulfill({ status: 401, json: { ...UNAUTHORIZED, message: "用户名或口令错误" } }),
  );
  await page.goto("/");
  await fill(page);
  await page.getByRole("button", { name: "登录" }).click();

  await expect(page.getByRole("alert")).toHaveText("用户名或密码错误");
  await expect(page).toHaveScreenshot("login-failed.png");
});

test("提交中显示加载态", async ({ page }) => {
  await signedOut(page);
  await page.route("/api/auth/login", () => {}); // 不响应，停留在提交中
  await page.goto("/");
  await fill(page);
  await page.getByRole("button", { name: "登录" }).click();

  await expect(page.getByRole("button", { name: "登录中…" })).toBeDisabled();
  await expect(page).toHaveScreenshot("login-pending.png", { animations: "disabled" });
});

test("登录成功后离开登录页", async ({ page }) => {
  let signedIn = false;
  await page.route("/api/site", (route) =>
    signedIn ? route.fulfill({ json: SITE }) : route.fulfill({ status: 401, json: UNAUTHORIZED }),
  );
  await page.route("/api/auth/login", (route) => {
    signedIn = true;
    return route.fulfill({ json: { role: "viewer", expires_at: "2026-10-27T08:00:00Z" } });
  });
  await page.goto("/");
  await fill(page);
  await page.getByRole("button", { name: "登录" }).click();

  await expect(page.getByRole("heading", { name: "欢迎回来" })).toBeHidden();
});
