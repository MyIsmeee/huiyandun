import { expect, type Page, test } from "@playwright/test";
import { expectNoOverflow, freezeClock, mockSocket, presetTheme, SITE, sceneSettled, signedIn } from "./helpers";

test.beforeEach(({ page }) => freezeClock(page));

const scene = (page: Page) => page.getByRole("region", { name: "场景" });
const SCENE_CHUNK = "**/assets/Scene3D-*.js";

test("由平面图生成 3D 场景：地面、栅格、墙体与区域名称", async ({ page }) => {
  await signedIn(page);
  await page.goto("/");
  await sceneSettled(page);

  await expect(scene(page).getByText("设备间外墙 · 禁止攀爬")).toBeVisible();
  await expectNoOverflow(page);
  await expect(scene(page)).toHaveScreenshot("scene-ready.png");
});

test("场景代码加载期间显示加载中", async ({ page }) => {
  await page.route(SCENE_CHUNK, () => {}); // 挂起不响应
  await signedIn(page);
  await page.goto("/");

  await expect(scene(page).getByText("场景加载中…")).toBeVisible();
  await expect(scene(page)).toHaveScreenshot("scene-loading.png");
});

test("场景代码加载失败时提示并可重新加载", async ({ page }) => {
  await page.route(SCENE_CHUNK, (route) => route.abort());
  await signedIn(page);
  await page.goto("/");
  await sceneSettled(page, "error");

  await expect(scene(page).getByText("场景加载失败")).toBeVisible();
  await expect(scene(page).getByRole("button", { name: "重新加载" })).toBeVisible();
  await expect(scene(page)).toHaveScreenshot("scene-error.png");
});

test("无 WebGL2 时降级为 2D 平面图（C-FE-08）", async ({ page }) => {
  await page.addInitScript(() => {
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, id: string, ...rest: unknown[]) {
      return id === "webgl2" ? null : getContext.call(this, id, ...(rest as []));
    } as typeof getContext;
  });
  await signedIn(page);
  await page.goto("/");
  await sceneSettled(page, "2d");

  await expect(scene(page).getByText("2D 平面视图 · 浏览器不支持 WebGL2")).toBeVisible();
  await expect(scene(page).getByText("设备间外墙 · 禁止攀爬")).toBeVisible();
  await expectNoOverflow(page);
  await expect(scene(page)).toHaveScreenshot("scene-2d.png");
});

test("平面图没有墙体与区域时显示空场景", async ({ page }) => {
  await page.route("/api/site", (route) => route.fulfill({ json: { ...SITE, walls: [], zones: [] } }));
  await mockSocket(page);
  await page.goto("/");
  await sceneSettled(page);

  await expect(scene(page).getByText("平面图中没有墙体与区域")).toBeVisible();
  await expect(scene(page)).toHaveScreenshot("scene-empty.png");
});

// §5.1 光照：太阳方位与高度角随本地时间变化，夜间为月光；只改变明暗与阴影方向。
// 主题用自动档，与用户在该时刻实际看到的一致：白天亮色、夜间暗色（§3.1）
for (const [name, time] of [
  ["morning", "2026-10-28T00:00:00Z"], // 上海 08:00：太阳在东，近侧的东墙阴影落入室内
  ["noon", "2026-10-28T04:00:00Z"], // 上海 12:00
  ["dusk", "2026-10-27T09:30:00Z"], // 上海 17:30
  ["night", "2026-10-27T14:00:00Z"], // 上海 22:00
] as const) {
  test(`场景光照随时间变化：${name}`, async ({ page }) => {
    await page.clock.pauseAt(new Date(time));
    await presetTheme(page, "auto");
    await signedIn(page);
    await page.goto("/");
    await sceneSettled(page);

    await expect(scene(page)).toHaveScreenshot(`scene-${name}.png`);
  });
}
