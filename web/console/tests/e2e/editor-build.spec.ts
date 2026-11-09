import { expect, type Page, test } from "@playwright/test";
import { AREA, camera, freezeClock, presetMotion, SITE, signedIn } from "./helpers";

// 场景页搭建（设计 150 E-2，FR-908）：从模型库选模型，吸附网格放到地面上
test.beforeEach(({ page }) => freezeClock(page));

const DESK = { asset: "desk", x: 10, y: 10.5, rot: 0, len: null };
const editor = (page: Page) => page.getByRole("region", { name: "场景编辑" });
const library = (page: Page) => page.getByRole("complementary", { name: "模型库" });
const canvas = (page: Page) => editor(page).locator("canvas");

/** 以 admin 打开场景页；返回模拟的 WS 服务端一侧 */
async function openEditor(page: Page, items: object[] = []) {
  await presetMotion(page, true);
  const sockets = await signedIn(page);
  await page.route("/api/auth/session", (route) => route.fulfill({ json: { username: "admin", role: "admin", expires_at: "2026-11-09T12:00:00Z" } }));
  await page.route("/api/site", (route) => route.fulfill({ json: { ...SITE, areas: [{ ...AREA, items }], devices: [camera("normal")] } }));
  await page.goto("/");
  await page.getByRole("navigation", { name: "导航" }).getByRole("button", { name: "场景" }).click();
  await expect(async () => {
    await page.clock.runFor(100);
    await expect(page.locator("[data-editor]")).toHaveAttribute("data-editor", "ready", { timeout: 50 });
  }).toPass({ intervals: [50] });
  return sockets;
}

/** 指针移到区域地面点 (x, y) 上方；click 时单击放下 */
async function pointAt(page: Page, [x, y]: [number, number], click = false) {
  const box = await canvas(page).boundingBox();
  const at = await page.evaluate((p) => window.__hydEditorAt?.(p.x, p.y), { x, y });
  if (!box || !at) throw new Error("编辑视图未就绪");
  await page.mouse.move(box.x + at[0], box.y + at[1]);
  if (click) await page.mouse.click(box.x + at[0], box.y + at[1]);
  await page.clock.runFor(50);
}

async function pickDesk(page: Page) {
  await library(page).getByRole("button", { name: /^家具/ }).click();
  await library(page).getByRole("button", { name: /^办公桌/ }).click();
  await page.clock.runFor(50); // 绘制一帧：新挂载的接收指针的地面要在绘制时才更新位置
}

/** 退出放置并移开指针，只剩已放下的物体 */
async function settle(page: Page) {
  await page.keyboard.press("Escape");
  await page.mouse.move(0, 0);
  await page.clock.runFor(50);
}

test("选模型后指针处显示吸附网格的半透明预览，单击放下；Esc 退出放置", async ({ page }) => {
  await openEditor(page);
  await pickDesk(page);
  await expect(editor(page).getByText("单击地面放置")).toBeVisible();
  await pointAt(page, [10.3, 10.4]);
  await expect(editor(page)).toHaveScreenshot("editor-placing.png"); // 半透明预览与蓝色占地

  await pointAt(page, [10.3, 10.4], true);
  await settle(page);
  await expect(editor(page).getByText("单击地面放置")).toHaveCount(0);
  await expect(library(page).getByRole("button", { name: /^办公桌/ })).toHaveAttribute("aria-pressed", "false");
  // 与区域里本来就有这张办公桌时一致
  const placed = await canvas(page).screenshot();
  await openEditor(page, [DESK]);
  expect(await canvas(page).screenshot()).toEqual(placed);
});

test("与已有物体重叠时不放置，只接触边缘可以放置", async ({ page }) => {
  await openEditor(page, [DESK]);
  const before = await canvas(page).screenshot();

  await pickDesk(page);
  await pointAt(page, [10.6, 10.4], true); // 吸附到 (11, 10.5)，与已有办公桌重叠
  await settle(page);
  expect(await canvas(page).screenshot()).toEqual(before);

  await pickDesk(page);
  await pointAt(page, [12.3, 10.4], true); // 吸附到 (12, 10.5)，与已有办公桌只接触边缘
  await settle(page);
  expect(await canvas(page).screenshot()).not.toEqual(before);
});

test("模型库按名称搜索", async ({ page }) => {
  await openEditor(page);
  await library(page).getByRole("textbox", { name: "搜索模型" }).fill("树");
  await expect(library(page).getByRole("group", { name: "模型" }).getByRole("button")).toHaveText([/^大树/, /^小树/]);
  await library(page).getByRole("textbox", { name: "搜索模型" }).fill("不存在");
  await expect(library(page).getByText("没有匹配的模型")).toBeVisible();
});
