import { readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { canvas, editor, editorReady, LOBBY, library, openEditor, pickDesk, pointAt, savedItems, settle } from "./editor-helpers";
import { AREA, camera, expectToast, freezeClock, SITE } from "./helpers";

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
  await generate(page, { frames: [STREET], unavailable: [{ camera_id: "cam-02", reason: "no_frame" }], stale: ["cam-02"] });

  await expectToast(page, "cam-02 没有画面（断流或刚接入）");
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

test("生成后又放下的物体与草稿重叠时，重叠的不接受", async ({ page }) => {
  await openEditor(page);
  await generate(page, { frames: [STREET], unavailable: [], stale: [] });
  await expect(bar(page)).toBeVisible();
  await pickDesk(page);
  await pointAt(page, [4, 17], true); // 落在草稿中建筑块（小办公楼，中心 (4, 17)）的占地上
  await settle(page);

  await bar(page).getByRole("button", { name: "全部接受" }).click();
  await expectToast(page, "1 件与已有物体重叠，未接受");
  const items = (await savedItems(page)) as { asset: string }[];
  expect(items.filter((i) => i.asset === "office-small")).toEqual([]);
  expect(items.filter((i) => i.asset === "desk")).toHaveLength(1);
});

test("放弃后场景回到生成前", async ({ page }) => {
  await openEditor(page);
  const before = await canvas(page).screenshot();
  await generate(page, { frames: [STREET], unavailable: [], stale: [] });
  await expect(bar(page)).toBeVisible();

  await bar(page).getByRole("button", { name: "放弃" }).click();
  await expect(bar(page)).toHaveCount(0);
  await page.clock.runFor(50);
  expect(await canvas(page).screenshot()).toEqual(before);
});

test("摄像头位置有未保存的修改时先提示保存，不取识别帧", async ({ page }) => {
  await openEditor(page);
  let requested = false;
  await page.route(FRAMES, (route) => {
    requested = true;
    return route.fulfill({ json: { frames: [STREET], unavailable: [], stale: [] } });
  });
  await library(page).getByRole("group", { name: "摄像头" }).getByRole("button", { name: "移出区域 cam-01" }).click();
  await editor(page).getByRole("button", { name: "从画面生成初稿" }).click();

  await expectToast(page, "摄像头位置有未保存的修改，请先保存再生成初稿");
  expect(requested).toBe(false);
  await expect(bar(page)).toHaveCount(0);
});

test("生成途中换了区域，结果丢弃", async ({ page }) => {
  await openEditor(page, [], [LOBBY]);
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(FRAMES, async (route) => {
    await held;
    await route.fulfill({ json: { frames: [STREET], unavailable: [{ camera_id: "cam-02", reason: "no_frame" }], stale: ["cam-02"] } });
  });
  await editor(page).getByRole("button", { name: "从画面生成初稿" }).click();
  await editor(page).getByRole("button", { name: /^区域：/ }).click();
  await page.getByRole("menuitemradio", { name: /一号楼大厅/ }).click();
  await expect(editor(page).getByRole("button", { name: "从画面生成初稿" })).toBeEnabled(); // 新区域不显示"生成中"

  const answered = page.waitForResponse(FRAMES);
  release();
  await answered;
  await page.clock.runFor(500);
  await expect(page.getByText("cam-02 没有画面（断流或刚接入）")).toHaveCount(0);
  await expect(bar(page)).toHaveCount(0);
});

test("区域被他人修改而重新载入时，未接受的初稿丢弃并提示", async ({ page }) => {
  const sockets = await openEditor(page);
  await generate(page, { frames: [STREET], unavailable: [], stale: [] });
  await expect(bar(page)).toBeVisible();

  // 摄像头页改了本区域的摄像头：区域 updated_at 变化，经 site 频道推送
  const changed = { ...AREA, updated_at: "2026-10-27T06:31:00Z" };
  sockets[0]?.send(JSON.stringify({ channel: "site", data: { ...SITE, areas: [changed], devices: [camera("normal")] } }));
  await expectToast(page, "区域已被修改并重新载入，未接受的初稿已丢弃，可重新生成");
  await expect(bar(page)).toHaveCount(0);
});

test("有未保存的修改时区域被他人修改：不重新载入，初稿保留、不提示", async ({ page }) => {
  const sockets = await openEditor(page);
  await generate(page, { frames: [STREET], unavailable: [], stale: [] });
  await expect(bar(page)).toBeVisible();
  await library(page).getByRole("group", { name: "摄像头" }).getByRole("button", { name: "移出区域 cam-01" }).click();

  const changed = { ...AREA, updated_at: "2026-10-27T06:31:00Z" };
  sockets[0]?.send(JSON.stringify({ channel: "site", data: { ...SITE, areas: [changed], devices: [camera("normal")] } }));
  await page.clock.runFor(500);
  await expect(page.getByText("未接受的初稿已丢弃", { exact: false })).toHaveCount(0);
  await expect(bar(page)).toBeVisible();
  await expect(editor(page).getByRole("button", { name: "保存" })).toBeEnabled(); // 未保存的修改仍在
});

test("没有识别帧或读取失败时说明原因，不出现草稿", async ({ page }) => {
  await openEditor(page);
  await generate(page, { frames: [], unavailable: [], stale: [] });
  await expectToast(page, "区域内还没有摄像头");

  await page.unroute(FRAMES);
  const unavailable = [
    { camera_id: "cam-01", reason: "model_missing" },
    { camera_id: "cam-02", reason: "model_missing" },
  ];
  await generate(page, { frames: [], unavailable, stale: ["cam-01", "cam-02"] });
  await expectToast(page, "cam-01、cam-02 未配置环境识别模型");

  await page.unroute(FRAMES);
  await generate(page, { code: "unavailable", message: "识别服务未响应，请稍后重试", request_id: "r" }, 503);
  await expectToast(page, "识别服务未响应，请稍后重试");

  await page.unroute(FRAMES);
  await generate(page, { code: "not_found", message: "区域不存在", request_id: "r" }, 404);
  await expectToast(page, "区域不存在");
  await expect(bar(page)).toHaveCount(0);
});
