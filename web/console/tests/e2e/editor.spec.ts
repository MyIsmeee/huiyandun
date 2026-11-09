import { expect, type Page, test } from "@playwright/test";
import { AREA, camera, expectNoOverflow, freezeClock, presetMotion, SITE, sceneSettled, signedIn, withoutWebGL2 } from "./helpers";

// 场景页（设计 150 §6，FR-908）：区域的选择与 3D 编辑视图
test.beforeEach(({ page }) => freezeClock(page));

const EDITOR_CHUNK = "**/assets/EditorCanvas-*.js";
const ITEMS = [
  { asset: "road", x: 0, y: 20, rot: 0, len: 40 },
  { asset: "office-small", x: 30, y: 7, rot: 0, len: null },
  { asset: "tree", x: 22, y: 14, rot: 0, len: null },
  { asset: "desk", x: 7, y: 10, rot: 90, len: null },
];
const LOBBY = { ...AREA, id: "area-02", name: "一号楼大厅", width_m: 20, depth_m: 12, items: [] };
const editor = (page: Page) => page.getByRole("region", { name: "场景编辑" });
const nav = (page: Page) => page.getByRole("navigation", { name: "导航" });

/** 以 admin 打开主界面；site 为 GET /api/site 的返回 */
async function asAdmin(page: Page, site: object = { ...SITE, areas: [{ ...AREA, items: ITEMS }], devices: [camera("normal")] }) {
  await presetMotion(page, true);
  const sockets = await signedIn(page);
  await page.route("/api/auth/session", (route) => route.fulfill({ json: { username: "admin", role: "admin", expires_at: "2026-11-09T12:00:00Z" } }));
  await page.route("/api/site", (route) => route.fulfill({ json: site }));
  return sockets;
}

/** 等编辑视图到达指定状态；时钟暂停时逐帧推进，使 3D 画布得以绘制首帧 */
async function editorSettled(page: Page, state: "ready" | "error" = "ready") {
  await expect(async () => {
    await page.clock.runFor(100);
    await expect(page.locator("[data-editor]")).toHaveAttribute("data-editor", state, { timeout: 50 });
  }).toPass({ intervals: [50] });
}

async function openEditor(page: Page) {
  await page.goto("/");
  await nav(page).getByRole("button", { name: "场景" }).click();
}

test("非 admin 不渲染场景页入口与去搭建（C-FE-07）", async ({ page }) => {
  await signedIn(page);
  await page.goto("/");
  await sceneSettled(page);

  await expect(page.getByText("该区域还没有搭建场景")).toBeVisible();
  await expect(nav(page).getByRole("button", { name: "场景" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "去搭建" })).toHaveCount(0);
});

test("态势页空区域提示旁的去搭建打开场景页", async ({ page }) => {
  await asAdmin(page, SITE);
  await page.goto("/");
  await sceneSettled(page);

  await page.getByRole("button", { name: "去搭建" }).click();
  await expect(editor(page).getByRole("heading", { name: "场景" })).toBeVisible();
  await editorSettled(page);
  await expect(editor(page).getByRole("button", { name: "区域：默认区域" })).toBeVisible();
});

test("编辑视图：区域场景、1 m 网格与摄像头（常态）", async ({ page }) => {
  await asAdmin(page);
  await openEditor(page);
  await editorSettled(page);

  await expectNoOverflow(page);
  await expect(editor(page)).toHaveScreenshot("editor-ready.png");
});

test("视角控件：旋转 90° 与返回总览", async ({ page }) => {
  await asAdmin(page);
  await openEditor(page);
  await editorSettled(page);
  const tools = editor(page).getByRole("toolbar", { name: "视角" });
  const home = await editor(page).screenshot();

  await tools.getByRole("button", { name: "旋转 90°" }).click();
  await page.clock.runFor(100);
  expect(await editor(page).screenshot()).not.toEqual(home);
  await tools.getByRole("button", { name: "放大" }).click();
  await tools.getByRole("button", { name: "返回总览" }).click();
  await page.mouse.move(700, 300); // 移开指针，按钮不留悬停底色
  await page.clock.runFor(100);
  await expect(editor(page)).toHaveScreenshot("editor-ready.png");
});

test("区域切换：列出全部区域及尺寸，选中后编辑该区域", async ({ page }) => {
  await asAdmin(page, { ...SITE, areas: [{ ...AREA, items: ITEMS }, LOBBY], devices: [camera("normal")] });
  await openEditor(page);
  await editorSettled(page);

  await editor(page).getByRole("button", { name: "区域：默认区域" }).click();
  await expect(page.getByRole("menuitemradio")).toHaveText(["默认区域40×24 m", "一号楼大厅20×12 m"]);
  await page.getByRole("menuitemradio", { name: /一号楼大厅/ }).click();
  await expect(editor(page).getByRole("button", { name: "区域：一号楼大厅" })).toBeVisible();
  await editorSettled(page);
});

test("没有区域：空态", async ({ page }) => {
  await asAdmin(page, { ...SITE, areas: [] });
  await openEditor(page);

  await expect(editor(page).getByText("还没有场景区域")).toBeVisible();
  await expectNoOverflow(page);
  await expect(editor(page)).toHaveScreenshot("editor-empty.png");
});

test("编辑视图加载中", async ({ page }) => {
  await page.route(EDITOR_CHUNK, () => {}); // 挂起不响应
  await asAdmin(page);
  await openEditor(page);

  await expect(editor(page).getByText("场景加载中…")).toBeVisible();
  await expect(editor(page)).toHaveScreenshot("editor-loading.png");
});

test("编辑视图加载失败：提示并可重新加载", async ({ page }) => {
  await page.route(EDITOR_CHUNK, (route) => route.abort());
  await asAdmin(page);
  await openEditor(page);
  await editorSettled(page, "error");

  await expect(editor(page).getByText("场景加载失败")).toBeVisible();
  await expect(editor(page).getByRole("button", { name: "重新加载" })).toBeVisible();
  await expect(editor(page)).toHaveScreenshot("editor-error.png");
});

test("浏览器不支持 WebGL2：说明场景编辑需要 WebGL2", async ({ page }) => {
  await withoutWebGL2(page);
  await asAdmin(page);
  await openEditor(page);

  await expect(editor(page).getByText("场景编辑需要支持 WebGL2 的浏览器")).toBeVisible();
});

test("断线：提示数据非实时（V-U3）", async ({ page }) => {
  const sockets = await asAdmin(page); // 连接建立后才有元素
  await openEditor(page);
  await editorSettled(page);

  await page.routeWebSocket("/ws", (route) => route.close());
  await sockets[0]?.close();
  await expect(editor(page).getByText(/^数据非实时/)).toBeVisible();
  await expect(editor(page)).toHaveScreenshot("editor-disconnected.png");
});
