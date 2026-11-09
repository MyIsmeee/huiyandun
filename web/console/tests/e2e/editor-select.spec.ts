import { expect, type Page, test } from "@playwright/test";
import { canvas, DESK, editor, openEditor, pointAt } from "./editor-helpers";
import { AREA, expectToast, freezeClock } from "./helpers";

// 场景页选中、移动、旋转、删除（设计 150 E-4）
test.beforeEach(({ page }) => freezeClock(page));

/** 办公桌桌面的高度：按在桌面上才点中办公桌，地面点的射线会从桌下穿过 */
const DESK_TOP = 0.7;
const toolbar = (page: Page) => editor(page).getByRole("toolbar", { name: "选中的物体" });

/** 保存，返回提交的物体：以保存的请求体核对编辑结果 */
async function savedItems(page: Page): Promise<unknown[]> {
  await page.route(`/api/scene/areas/${AREA.id}`, (route) => route.fulfill({ json: { ...AREA, ...route.request().postDataJSON() } }));
  const request = page.waitForRequest((r) => r.method() === "PUT");
  await editor(page).getByRole("button", { name: "保存" }).click();
  return (await request).postDataJSON().items as unknown[];
}

/** 按住 from 处的办公桌（桌面）拖到地面点 to 上方，再松开 */
async function drag(page: Page, from: [number, number], to: [number, number]) {
  const box = await canvas(page).boundingBox();
  const at = ([x, y]: [number, number], h = 0) => page.evaluate((q) => window.__hydEditorAt?.(q.x, q.y, q.h), { x, y, h });
  const [a, b] = [await at(from, DESK_TOP), await at(to, DESK_TOP)];
  if (!box || !a || !b) throw new Error("编辑视图未就绪");
  await page.mouse.move(box.x + a[0], box.y + a[1]);
  await page.mouse.down();
  await page.mouse.move(box.x + (a[0] + b[0]) / 2, box.y + (a[1] + b[1]) / 2);
  await page.mouse.move(box.x + b[0], box.y + b[1]);
  await page.mouse.up();
  await page.clock.runFor(50);
}

test("单击物体选中：四角括框与工具条；单击空白处取消", async ({ page }) => {
  await openEditor(page, [DESK]);
  await pointAt(page, [10, 10.5], true, DESK_TOP);
  await expect(toolbar(page)).toContainText("选中：办公桌");
  await expect(editor(page)).toHaveScreenshot("editor-selected.png");

  await pointAt(page, [25, 5], true);
  await expect(toolbar(page)).toHaveCount(0);
});

test("拖动按整米移动；拖到其他物体上松开时回到原处", async ({ page }) => {
  const other = { ...DESK, x: 16 };
  await openEditor(page, [DESK, other]);
  await drag(page, [10, 10.5], [15.2, 10.6]); // 移到 (15, 10.5)，与另一张办公桌重叠
  await expect(editor(page).getByRole("button", { name: "保存" })).toBeDisabled();

  await drag(page, [10, 10.5], [12.2, 12.4]);
  expect(await savedItems(page)).toEqual([{ ...DESK, x: 12, y: 12.5 }, other]);
});

test("R 旋转、Delete 删除，可撤销；旋转后会重叠时不转并说明", async ({ page }) => {
  const below = { ...DESK, y: 11.5 }; // 与办公桌只接触边缘；办公桌转 90° 后会与之重叠
  await openEditor(page, [DESK, below]);
  await pointAt(page, [10, 10.5], true, DESK_TOP);
  await page.keyboard.press("r");
  await expectToast(page, "旋转后会超出区域或与其他物体重叠");
  await expect(editor(page).getByRole("button", { name: "保存" })).toBeDisabled();

  await pointAt(page, [10, 11.5], true, DESK_TOP); // 选中下面一张，转后朝下没有遮挡
  await page.keyboard.press("r");
  await page.keyboard.press("Control+Z");
  await pointAt(page, [10, 11.5], true, DESK_TOP);
  await toolbar(page).getByRole("button", { name: /^删除/ }).click();
  expect(await savedItems(page)).toEqual([DESK]);
});
