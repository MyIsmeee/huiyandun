import { expect, type Page } from "@playwright/test";
import { AREA, camera, presetMotion, SITE, signedIn } from "./helpers";

// 场景页用例共用：以 admin 打开场景页，按区域地面坐标移动指针与单击

export const DESK = { asset: "desk", x: 10, y: 10.5, rot: 0, len: null };
export const editor = (page: Page) => page.getByRole("region", { name: "场景编辑" });
export const library = (page: Page) => page.getByRole("complementary", { name: "模型库" });
export const canvas = (page: Page) => editor(page).locator("canvas");

export const LOBBY = { ...AREA, id: "area-02", name: "一号楼大厅", width_m: 20, depth_m: 12 };

/** 以 admin 打开场景页，编辑第一个区域（items 为其中的物体）；返回模拟的 WS 服务端一侧 */
export async function openEditor(page: Page, items: object[] = [], others: object[] = [], devices: object[] = [camera("normal")]) {
  await presetMotion(page, true);
  const sockets = await signedIn(page);
  await page.route("/api/auth/session", (route) => route.fulfill({ json: { username: "admin", role: "admin", expires_at: "2026-11-09T12:00:00Z" } }));
  await page.route("/api/site", (route) => route.fulfill({ json: { ...SITE, areas: [{ ...AREA, items }, ...others], devices } }));
  await page.goto("/");
  await page.getByRole("navigation", { name: "导航" }).getByRole("button", { name: "场景" }).click();
  await editorReady(page);
  return sockets;
}

/** 等编辑视图绘制首帧（换区域后画布重新挂载）；时钟暂停时逐帧推进 */
export async function editorReady(page: Page) {
  await expect(async () => {
    await page.clock.runFor(100);
    await expect(page.locator("[data-editor]")).toHaveAttribute("data-editor", "ready", { timeout: 50 });
  }).toPass({ intervals: [50] });
}

/** 指针移到区域内 (x, y) 处高 h 米的点（默认地面）；click 时单击 */
export async function pointAt(page: Page, [x, y]: [number, number], click = false, h = 0) {
  const box = await canvas(page).boundingBox();
  const at = await page.evaluate((p) => window.__hydEditorAt?.(p.x, p.y, p.h), { x, y, h });
  if (!box || !at) throw new Error("编辑视图未就绪");
  await page.mouse.move(box.x + at[0], box.y + at[1]);
  if (click) await page.mouse.click(box.x + at[0], box.y + at[1]);
  await page.clock.runFor(50);
}

export async function pickDesk(page: Page) {
  await library(page).getByRole("button", { name: /^家具/ }).click();
  await library(page).getByRole("button", { name: /^办公桌/ }).click();
  await page.clock.runFor(50); // 绘制一帧：新挂载的接收指针的地面要在绘制时才更新位置
}

/** 退出放置并移开指针，只剩已放下的物体 */
export async function settle(page: Page) {
  await page.keyboard.press("Escape");
  await page.mouse.move(0, 0);
  await page.clock.runFor(50);
}

/** 保存，返回提交的物体：以保存的请求体核对编辑结果 */
export async function savedItems(page: Page): Promise<unknown[]> {
  await page.route(`/api/scene/areas/${AREA.id}`, (route) => route.fulfill({ json: { ...AREA, ...route.request().postDataJSON() } }));
  const request = page.waitForRequest((r) => r.method() === "PUT");
  await editor(page).getByRole("button", { name: "保存" }).click();
  return (await request).postDataJSON().items as unknown[];
}

/** 保存，返回提交的摄像头位置与朝向 */
export async function savedCameras(page: Page): Promise<unknown[]> {
  await page.route(`/api/scene/areas/${AREA.id}`, (route) => route.fulfill({ json: { ...AREA, ...route.request().postDataJSON() } }));
  const request = page.waitForRequest((r) => r.method() === "PUT");
  await editor(page).getByRole("button", { name: "保存" }).click();
  return (await request).postDataJSON().cameras as unknown[];
}

/** 在地面上从 from 按下拖到 to 再松开（画线状资产） */
export async function dragOnGround(page: Page, from: [number, number], to: [number, number]) {
  const box = await canvas(page).boundingBox();
  const at = ([x, y]: [number, number]) => page.evaluate((q) => window.__hydEditorAt?.(q.x, q.y), { x, y });
  const [a, b] = [await at(from), await at(to)];
  if (!box || !a || !b) throw new Error("编辑视图未就绪");
  await page.mouse.move(box.x + a[0], box.y + a[1]);
  await page.mouse.down();
  await page.mouse.move(box.x + (a[0] + b[0]) / 2, box.y + (a[1] + b[1]) / 2);
  await page.mouse.move(box.x + b[0], box.y + b[1]);
  await page.clock.runFor(50);
  await page.mouse.up();
  await page.clock.runFor(50);
}
