import { expect, type Page, test } from "@playwright/test";
import { dragOnGround, editor, library, openEditor, pointAt, savedCameras } from "./editor-helpers";
import { camera, expectToast, freezeClock } from "./helpers";

// 场景页放置摄像头（设计 150 E-5）：位置与朝向随区域整体保存写回登记表
test.beforeEach(({ page }) => freezeClock(page));

const CAM01 = { id: "cam-01", x: 16, y: 14, yaw_deg: 300 };
/** 未放入任何区域的摄像头 */
const free = () => {
  const device = camera("normal", "cam-02");
  return { ...device, camera: { ...device.camera, area_id: null } };
};
const cameras = (page: Page) => library(page).getByRole("group", { name: "摄像头" });

test("未放置的摄像头：按下放置，拖动方向为朝向；保存时与本区域摄像头一起写回", async ({ page }) => {
  await openEditor(page, [], [], [camera("normal"), free()]);
  await expect(cameras(page).getByRole("button", { name: /^cam-02/ })).toContainText("未放置");
  await cameras(page).getByRole("button", { name: /^cam-02/ }).click();
  await expect(editor(page).getByText("按下地面放置摄像头")).toBeVisible();
  await page.clock.runFor(50);
  await dragOnGround(page, [30.2, 5.1], [30.4, 12]); // 朝 +y：90°

  await expect(cameras(page).getByRole("button", { name: "移出区域 cam-02" })).toBeVisible();
  await page.mouse.move(0, 0);
  await expect(editor(page)).toHaveScreenshot("editor-camera-placed.png");
  expect(await savedCameras(page)).toEqual([CAM01, { id: "cam-02", x: 30, y: 5, yaw_deg: 90 }]);
});

test("移出已标定的摄像头：提示保存后标定清除；撤销放回后提示撤掉（D-134、A18）", async ({ page }) => {
  await openEditor(page); // cam-01 有 4 组标定点
  await cameras(page).getByRole("button", { name: "移出区域 cam-01" }).click();
  await expectToast(page, "保存后 cam-01 的地面标定将清除");

  await page.keyboard.press("Control+Z");
  await expect(cameras(page).getByRole("button", { name: "移出区域 cam-01" })).toBeVisible();
  // 退场动画按模拟时钟推进；总共只推进约 1 s，远短于提示自行消失的 4 s
  await expect(async () => {
    await page.clock.runFor(100);
    await expect(page.getByText("保存后 cam-01 的地面标定将清除")).toHaveCount(0, { timeout: 50 });
  }).toPass({ intervals: [50], timeout: 1000 });
});

test("移出区域可撤销；重新放置时单击不拖动保留原朝向", async ({ page }) => {
  await openEditor(page);
  await cameras(page).getByRole("button", { name: "移出区域 cam-01" }).click();
  await expect(cameras(page).getByRole("button", { name: /^cam-01/ })).toContainText("未放置");
  await page.keyboard.press("Control+Z");
  await expect(cameras(page).getByRole("button", { name: "移出区域 cam-01" })).toBeVisible();

  await cameras(page).getByRole("button", { name: "重新放置 cam-01" }).click();
  await page.clock.runFor(50);
  await pointAt(page, [5.2, 5.1], true);
  expect(await savedCameras(page)).toEqual([{ ...CAM01, x: 5, y: 5 }]);
});
