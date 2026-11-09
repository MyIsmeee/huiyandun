import { expect, type Page, test } from "@playwright/test";
import { canvas, DESK, dragOnGround, editor, editorReady, LOBBY, library, openEditor, pickDesk, pointAt, savedItems, settle } from "./editor-helpers";
import { AREA, camera, expectToast, freezeClock, SITE, sceneSettled } from "./helpers";

// 场景页搭建（设计 150 E-2、E-7，FR-908）：从模型库选模型吸附网格放到地面上，整体保存，态势页随推送更新
test.beforeEach(({ page }) => freezeClock(page));

const SAVED_AT = "2026-11-09T06:00:00Z";

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

test("放置并保存：态势页随 site 推送出现新物体（FR-908）", async ({ page }) => {
  const sockets = await openEditor(page);
  const save = editor(page).getByRole("button", { name: "保存" });
  await expect(save).toBeDisabled(); // 没有修改

  await pickDesk(page);
  await pointAt(page, [10.3, 10.4], true);

  const saved = { ...AREA, items: [DESK], updated_at: SAVED_AT };
  await page.route(`/api/scene/areas/${AREA.id}`, (route) => route.fulfill({ json: saved }));
  const request = page.waitForRequest((r) => r.method() === "PUT");
  await save.click();
  expect((await request).postDataJSON()).toEqual({
    name: AREA.name,
    width_m: AREA.width_m,
    depth_m: AREA.depth_m,
    items: [DESK],
    cameras: [{ id: "cam-01", x: 16, y: 14, yaw_deg: 300 }], // 本区域摄像头原样带上，否则会被移出区域
    updated_at: AREA.updated_at,
  });
  await expectToast(page, "已保存，态势页随后更新");
  await expect(save).toBeDisabled();

  // 服务端经 site 频道推送新场景，回到态势页
  sockets[0]?.send(JSON.stringify({ channel: "site", data: { ...SITE, areas: [saved], devices: [camera("normal")] } }));
  await editor(page).getByRole("button", { name: "返回", exact: true }).click();
  await sceneSettled(page);
  await expect(page.getByText("该区域还没有搭建场景")).toHaveCount(0, { timeout: 5000 });
});

test("保存时场景已被他人修改（409）：提示并可重新载入，丢弃本页修改", async ({ page }) => {
  await openEditor(page);
  await pickDesk(page);
  await pointAt(page, [10.3, 10.4], true);
  await page.route(`/api/scene/areas/${AREA.id}`, (route) => route.fulfill({ status: 409, json: { code: "conflict", message: "场景已被修改", request_id: "r" } }));

  await editor(page).getByRole("button", { name: "保存" }).click();
  await expectToast(page, "场景已被其他人修改");

  const latest = { ...AREA, items: [{ asset: "tree", x: 20, y: 12, rot: 0, len: null }], updated_at: SAVED_AT };
  await page.route("/api/site", (route) => route.fulfill({ json: { ...SITE, areas: [latest], devices: [camera("normal")] } }));
  await page.getByRole("button", { name: "重新载入" }).click();
  await expect(editor(page).getByRole("button", { name: "保存" })).toBeDisabled(); // 已换成最新内容，没有未保存的修改
});

test("放置点超出区域等错误（400）：显示服务端指出的原因", async ({ page }) => {
  await openEditor(page);
  await pickDesk(page);
  await pointAt(page, [10.3, 10.4], true);
  const message = "第 1 个物体（办公桌）超出区域";
  await page.route(`/api/scene/areas/${AREA.id}`, (route) => route.fulfill({ status: 400, json: { code: "invalid", message, request_id: "r" } }));

  await editor(page).getByRole("button", { name: "保存" }).click();
  await expectToast(page, message);
  await expect(editor(page).getByRole("button", { name: "保存" })).toBeEnabled(); // 修改保留
});

test("撤销与重做：按钮与 Ctrl+Z / Ctrl+Shift+Z（设计 150 E-6）", async ({ page }) => {
  await openEditor(page);
  const button = (name: string) => editor(page).getByRole("button", { name, exact: true });
  const [save, undoButton, redoButton] = [button("保存"), button("撤销"), button("重做")];
  await expect(undoButton).toBeDisabled();
  await placeDesk(page);

  await undoButton.click();
  await expect(save).toBeDisabled(); // 回到已保存的内容
  await expect(redoButton).toBeEnabled();
  await page.keyboard.press("Control+Shift+Z");
  await expect(save).toBeEnabled();
  await page.keyboard.press("Control+Z");
  await expect(save).toBeDisabled();
});

/** 放下一张办公桌，成为未保存的修改 */
async function placeDesk(page: Page) {
  await pickDesk(page);
  await pointAt(page, [10.3, 10.4], true);
  await settle(page);
}

async function switchTo(page: Page, name: string) {
  await editor(page).getByRole("button", { name: /^区域：/ }).click();
  await page.getByRole("menuitemradio", { name: new RegExp(name) }).click();
}

test("有未保存的修改时换区域先确认，可继续编辑；关闭标签页由浏览器提示", async ({ page }) => {
  await openEditor(page, [], [LOBBY]);
  await placeDesk(page);

  await switchTo(page, "一号楼大厅");
  await page.getByRole("alertdialog", { name: "放弃未保存的修改？" }).getByRole("button", { name: "继续编辑" }).click();
  await expect(editor(page).getByRole("button", { name: "区域：默认区域" })).toBeVisible();
  await expect(editor(page).getByRole("button", { name: "保存" })).toBeEnabled();

  let prompted = false;
  page.on("dialog", (dialog) => {
    prompted = dialog.type() === "beforeunload";
    void dialog.dismiss();
  });
  await page.close({ runBeforeUnload: true });
  await expect.poll(() => prompted).toBe(true);
});

test("放弃修改后换区域；返回时同样先确认，没有修改时直接返回", async ({ page }) => {
  await openEditor(page, [], [LOBBY]);
  await placeDesk(page);
  await switchTo(page, "一号楼大厅");
  await page.getByRole("alertdialog", { name: "放弃未保存的修改？" }).getByRole("button", { name: "放弃修改" }).click();
  await expect(editor(page).getByRole("button", { name: "区域：一号楼大厅" })).toBeVisible();
  await expect(editor(page).getByRole("button", { name: "保存" })).toBeDisabled();

  await editorReady(page);
  await placeDesk(page);
  const back = editor(page).getByRole("button", { name: "返回", exact: true });
  await back.click();
  await page.getByRole("alertdialog", { name: "放弃未保存的修改？" }).getByRole("button", { name: "放弃修改" }).click();
  await expect(editor(page)).toHaveCount(0);

  await page.getByRole("navigation", { name: "导航" }).getByRole("button", { name: "场景" }).click();
  await editor(page).getByRole("button", { name: "返回", exact: true }).click();
  await expect(editor(page)).toHaveCount(0);
});

test("墙按下拖动画线，按网格分段；普通物体放置前按 R 旋转（设计 150 E-3）", async ({ page }) => {
  await openEditor(page);
  await library(page).getByRole("button", { name: /^墙与围栏/ }).click();
  await library(page).getByRole("group", { name: "模型" }).getByRole("button", { name: /^墙 / }).click();
  await page.clock.runFor(50);
  await dragOnGround(page, [5.2, 4.9], [12.3, 5.4]);
  await dragOnGround(page, [20, 3], [20.4, 9.6]);

  await pickDesk(page);
  await page.keyboard.press("r");
  await pointAt(page, [10.3, 10.4], true);
  expect(await savedItems(page)).toEqual([
    { asset: "wall", x: 5, y: 5.5, rot: 0, len: 8 },
    { asset: "wall", x: 20.5, y: 3, rot: 90, len: 6 },
    { ...DESK, x: 10.5, y: 10, rot: 90 },
  ]);
});
