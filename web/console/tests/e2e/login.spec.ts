import { expect, type Page, test } from "@playwright/test";
import { expectNoOverflow, presetMotion, SITE, UNAUTHORIZED } from "./helpers";


// 地球按真实时刻计算昼夜并持续自转，截图前隐藏地球层（全屏，遮罩会盖住表单），基线只核对页面其余部分（V-P2）
async function hideGlobe(page: Page) {
  await page.addStyleTag({ content: '[data-testid="globe-stage"] { visibility: hidden; }' });
}

async function signedOut(page: Page) {
  await page.route("/api/site", (route) => route.fulfill({ status: 401, json: UNAUTHORIZED }));
}

async function fill(page: Page) {
  await page.getByLabel("用户名").fill("viewer");
  await page.getByLabel("密码", { exact: true }).fill("secret");
}

test(`未登录时显示登录页`, async ({ page }) => {
  await presetMotion(page);
  await signedOut(page);
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "欢迎回来" })).toBeVisible();
  await expectNoOverflow(page);
  await hideGlobe(page);
  await expect(page).toHaveScreenshot(`login.png`);
});

test("窄屏只保留表单", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 900 });
  await signedOut(page);
  await page.goto("/");

  await expect(page.getByText("一屏联动")).toBeHidden();
  await expectNoOverflow(page);
  await hideGlobe(page);
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
  await hideGlobe(page);
  await expect(page).toHaveScreenshot("login-failed.png");
});

test("提交中显示加载态", async ({ page }) => {
  await signedOut(page);
  await page.route("/api/auth/login", () => {}); // 不响应，停留在提交中
  await page.goto("/");
  await fill(page);
  await page.getByRole("button", { name: "登录" }).click();

  await expect(page.getByRole("button", { name: "登录中…" })).toBeDisabled();
  await hideGlobe(page);
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

  // 先播放地球俯冲过渡（约 3 s，软件渲染下更久），结束后登录页移除
  await expect(page.getByRole("heading", { name: "欢迎回来" })).toBeHidden({ timeout: 20_000 });
});

test("降低动效时登录后直接进入主界面，不播放过渡", async ({ page }) => {
  await presetMotion(page, true);
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

  await expect(page.getByRole("heading", { name: "欢迎回来" })).toBeHidden({ timeout: 8_000 });
});

test("会话检测失败且不是 401 时可重试", async ({ page }) => {
  let status = 500;
  await page.route("/api/site", (route) =>
    route.fulfill({ status, json: { code: "internal_server_error", message: "服务器内部错误", request_id: "r" } }),
  );
  await page.goto("/");

  await expect(page.getByText("无法连接服务器")).toBeVisible();
  await expect(page).toHaveScreenshot("unreachable.png");

  status = 401;
  await page.getByRole("button", { name: "重试" }).click();
  await expect(page.getByRole("heading", { name: "欢迎回来" })).toBeVisible();
});

test("不是 HTTPS 访问时直接说明，不发请求", async ({ page }) => {
  let requested = false;
  await page.route("/api/**", (route) => {
    requested = true;
    return route.abort();
  });
  await page.addInitScript(() => Object.defineProperty(window, "isSecureContext", { value: false }));
  await page.goto("/");

  await expect(page.getByText("请通过 HTTPS 地址访问控制台")).toBeVisible();
  expect(requested).toBe(false);
  await expect(page).toHaveScreenshot("insecure.png");
});
