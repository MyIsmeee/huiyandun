import { readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { canvas, editor, editorReady, openEditor, savedItems } from "./editor-helpers";
import { AREA, expectToast, freezeClock } from "./helpers";

// 从画面生成初稿（设计 150 §7，FR-909）：区域内摄像头的识别帧转换为半透明草稿，接受后随整体保存提交
test.beforeEach(({ page }) => freezeClock(page));

const FRAMES = `/api/scene/areas/${AREA.id}/frames`;
// 调试素材街道画面的识别帧（单元测试同一份，见 tests/unit/editor-recognition.test.ts）
const STREET = {
  schema_version: "1.1.0",
  event_id: "6f0d3c9e-1f7a-4d7b-9a51-3c0e4b8d2a10",
  ts: "2026-10-27T06:29:59Z",
  ...JSON.parse(readFileSync(new URL("../unit/fixtures/scene-street-1.json", import.meta.url), "utf8")),
};

async function generate(page: Page, body: object, status = 200) {
  await page.route(FRAMES, (route) => route.fulfill({ status, json: body }));
  await editor(page).getByRole("button", { name: "从画面生成初稿" }).click();
}
const bar = (page: Page) => editor(page).getByRole("toolbar", { name: "初稿" });

test("生成后叠加半透明草稿、不算修改；全部接受后随保存提交", async ({ page }) => {
  await openEditor(page);
  await generate(page, { frames: [STREET], stale: ["cam-02"] });

  await expectToast(page, "cam-02 暂无识别结果");
  await expect(bar(page)).toContainText(/初稿 \d+ 件/);
  await editorReady(page);
  await expect(editor(page)).toHaveScreenshot("editor-draft.png"); // 半透明模型 + 蓝色虚线占地
  await expect(editor(page).getByRole("button", { name: "保存" })).toBeDisabled(); // 草稿不自动保存

  const count = Number((await bar(page).textContent())?.match(/初稿 (\d+) 件/)?.[1]);
  await bar(page).getByRole("button", { name: "全部接受" }).click();
  await expect(bar(page)).toHaveCount(0);
  const items = (await savedItems(page)) as { asset: string }[];
  expect(items).toHaveLength(count);
  expect(items.map((i) => i.asset)).toEqual(expect.arrayContaining(["road", "plaza"]));
});

test("放弃后场景回到生成前", async ({ page }) => {
  await openEditor(page);
  const before = await canvas(page).screenshot();
  await generate(page, { frames: [STREET], stale: [] });
  await expect(bar(page)).toBeVisible();

  await bar(page).getByRole("button", { name: "放弃" }).click();
  await expect(bar(page)).toHaveCount(0);
  await page.clock.runFor(50);
  expect(await canvas(page).screenshot()).toEqual(before);
});

test("没有识别帧或读取失败时说明原因，不出现草稿", async ({ page }) => {
  await openEditor(page);
  await generate(page, { frames: [], stale: [] });
  await expectToast(page, "区域内还没有摄像头");

  await page.unroute(FRAMES);
  await generate(page, { code: "not_found", message: "区域不存在", request_id: "r" }, 404);
  await expectToast(page, "区域不存在");
  await expect(bar(page)).toHaveCount(0);
});
