import { expect, type Page, test } from "@playwright/test";
import { expectNoOverflow, freezeClock, mockSocket, SITE, signedIn, UNAUTHORIZED } from "./helpers";

test.beforeEach(({ page }) => freezeClock(page));

const status = (page: Page) => page.getByRole("status", { name: "连接状态" });

test("连上后显示实时", async ({ page }) => {
  await signedIn(page);
  await page.goto("/");

  await expect(status(page)).toHaveText("实时");
  await expect(page.locator("header")).toHaveScreenshot("header-live.png");
});

test("超过 2 个心跳周期无数据显示延迟", async ({ page }) => {
  const sockets = await signedIn(page);
  await page.goto("/");
  await expect(status(page)).toHaveText("实时");

  await page.clock.runFor(5_000);
  sockets[0]?.send(JSON.stringify({ channel: "system", data: { type: "heartbeat" } }));
  await page.clock.runFor(10_000);
  await expect(status(page)).toHaveText("实时");
  await page.clock.runFor(1_000);

  await expect(status(page)).toHaveText("延迟 · 最后更新 14:30:05");
  await expect(page.locator("header")).toHaveScreenshot("header-delayed.png");
});

test("断线时提示数据非实时，并自动重连", async ({ page }) => {
  const sockets = await signedIn(page);
  await page.goto("/");
  await expect(status(page)).toHaveText("实时");

  await sockets[0]?.close({ code: 1011 });

  await expect(status(page)).toHaveText("断线 · 重连中");
  await expect(page.getByText("数据非实时 · 最后更新 14:30:00")).toBeVisible();
  await expectNoOverflow(page);
  await expect(page).toHaveScreenshot("offline.png");

  await page.clock.runFor(1_000);
  await expect(status(page)).toHaveText("实时");
  expect(sockets).toHaveLength(2);
});

test("会话失效时回到登录页", async ({ page }) => {
  let expired = false;
  await page.route("/api/site", (route) =>
    expired ? route.fulfill({ status: 401, json: UNAUTHORIZED }) : route.fulfill({ json: SITE }),
  );
  const sockets = await mockSocket(page);
  await page.goto("/");
  await expect(status(page)).toHaveText("实时");

  expired = true;
  await sockets[0]?.close({ code: 1008 });

  await expect(page.getByRole("heading", { name: "欢迎回来" })).toBeVisible();
});
