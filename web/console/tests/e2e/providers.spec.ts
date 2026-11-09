import { expect, test } from "@playwright/test";
import { expectNoOverflow, openAdmin, signedIn } from "./helpers";

const PUBLIC = {
  id: "p-2", name: "DeepSeek 官方", preset: "deepseek", base_url: "https://api.deepseek.com/v1",
  api_key_last4: "3f9a", model: "deepseek-chat", network: "public", network_overridden: false,
  structured_output: null, timeout_s: 60, enabled: false, order: 0, usage_today: { calls: 0, tokens: 0 }, last_test: null,
}; // prettier-ignore

test.beforeEach(async ({ page }) => {
  await signedIn(page);
  await page.route("/api/llm/providers", (route) => route.fulfill({ json: { items: [PUBLIC] } }));
  await page.route("/api/llm/settings", (route) => route.fulfill({ json: { block_public: false } }));
});

for (const role of ["viewer", "operator"]) {
  test(`角色 ${role} 不渲染供应商入口（C-FE-07）`, async ({ page }) => {
    await page.route("/api/auth/session", (route) => route.fulfill({ json: { username: role, role, expires_at: "2026-11-08T00:00:00Z" } }));
    const session = page.waitForResponse("/api/auth/session");
    await page.goto("/");
    await session;
    await expect(page.getByRole("button", { name: "退出登录" })).toBeVisible();
    await expect(page.getByRole("button", { name: "管理" })).toHaveCount(0);
  });
}

test("admin 打开供应商页，启用公网供应商前确认（V-M2）", async ({ page }) => {
  await page.route("/api/auth/session", (route) => route.fulfill({ json: { username: "admin", role: "admin", expires_at: "2026-11-08T00:00:00Z" } }));
  await page.goto("/");
  await openAdmin(page, "模型供应商");
  await page.getByRole("switch", { name: "启用 DeepSeek 官方" }).click();

  const dialog = page.getByRole("alertdialog", { name: "启用公网供应商" });
  await expect(dialog).toContainText("脱敏后发送至 api.deepseek.com");
  await expectNoOverflow(page);
  await expect(page).toHaveScreenshot("providers-confirm.png");

  await dialog.getByRole("button", { name: "取消" }).click();
  await page.getByRole("button", { name: "返回", exact: true }).click();
  await expect(page.getByRole("region", { name: "模型供应商" })).toHaveCount(0);
});

test("编辑框点对话框外不关闭，未保存的填写不丢；Esc 关闭", async ({ page }) => {
  await page.route("/api/auth/session", (route) => route.fulfill({ json: { username: "admin", role: "admin", expires_at: "2026-11-08T00:00:00Z" } }));
  await page.goto("/");
  await openAdmin(page, "模型供应商");
  await page.getByRole("button", { name: "添加", exact: true }).click();

  const dialog = page.getByRole("dialog", { name: "添加供应商" });
  await dialog.getByRole("textbox", { name: "名称" }).fill("本地模型");
  await page.mouse.click(5, 5);
  await expect(dialog.getByRole("textbox", { name: "名称" })).toHaveValue("本地模型");

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});
