import { expect, type Page, test, type WebSocketRoute } from "@playwright/test";
import { camera, expectNoOverflow, freezeClock, open, presetTheme, sceneSettled, signedIn } from "./helpers";

test.beforeEach(({ page }) => freezeClock(page));

const scene = (page: Page) => page.getByRole("region", { name: "场景" });
const SCENE_CHUNK = "**/assets/Scene3D-*.js";

test("3D 场景只有无限延伸的地面与栅格，不显示平面图的墙体与区域（UP-1）", async ({ page }) => {
  await signedIn(page);
  await page.goto("/");
  await sceneSettled(page);

  await expect(scene(page).getByText("设备间外墙")).toHaveCount(0);
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

test("无 WebGL2 时降级为 2D 俯视视图（C-FE-08）", async ({ page }) => {
  await page.addInitScript(() => {
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, id: string, ...rest: unknown[]) {
      return id === "webgl2" ? null : getContext.call(this, id, ...(rest as []));
    } as typeof getContext;
  });
  await signedIn(page);
  await page.goto("/");
  await sceneSettled(page, "2d");

  await expect(scene(page).getByText("2D 视图 · 不支持 WebGL2")).toBeVisible();
  // V-P3：最窄的 1366 宽下，含降级说明的控件组不与 KPI 底板重叠
  await page.setViewportSize({ width: 1366, height: 768 });
  const [kpi, toolbar] = await Promise.all([
    page.getByRole("list", { name: "关键指标" }).boundingBox(),
    page.getByRole("toolbar", { name: "视角" }).boundingBox(),
  ]);
  expect((kpi?.x ?? 0) + (kpi?.width ?? 0)).toBeLessThan(toolbar?.x ?? 0);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(scene(page).getByText("设备间外墙")).toHaveCount(0);
  await expectNoOverflow(page);
  await expect(scene(page)).toHaveScreenshot("scene-2d.png");
});

// §5.1 光照：太阳方位与高度角随本地时间变化，夜间为月光；只改变明暗与阴影方向。
// 主题用自动档，与用户在该时刻实际看到的一致：白天亮色、夜间暗色（§3.1）
for (const [name, time] of [
  ["morning", "2026-10-28T00:00:00Z"], // 上海 08:00：太阳在东
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

// V-I1、V-I5、V-A2、V-A4：相机控件；以未标定摄像头的状态标签为参照点
test.describe("相机控件", () => {
  const LABEL = "未标定";
  const button = (page: Page, name: string) => page.getByRole("toolbar", { name: "视角" }).getByRole("button", { name });
  const labelAt = async (page: Page) => {
    const box = await scene(page).getByText(LABEL).boundingBox();
    return box && [Math.round(box.x), Math.round(box.y)];
  };
  const transition = (page: Page) => page.clock.runFor(600); // 转场 ≤ 600 ms

  let sockets: WebSocketRoute[] = [];

  test.beforeEach(async ({ page }) => {
    sockets = await open(page, [camera("uncalibrated")]);
  });

  test("四个旋转档位，返回总览回到默认机位", async ({ page }) => {
    for (const k of [1, 2, 3]) {
      await button(page, "向右旋转 90°").click();
      await transition(page);
      await expect(scene(page)).toHaveScreenshot(`scene-rotate-${k}.png`);
    }
    await button(page, "放大").click();
    await button(page, "返回总览").click();
    await transition(page);

    await expect(scene(page)).toHaveScreenshot("scene-ready.png");
  });

  test("缩放限定为总览的 1～4 倍", async ({ page }) => {
    await expect(button(page, "缩小")).toBeDisabled();
    for (let i = 0; i < 4; i += 1) await button(page, "放大").click();

    await expect(button(page, "放大")).toBeDisabled();
    await expect(button(page, "缩小")).toBeEnabled();
  });

  test("放大后拖拽平移，画面跟随指针", async ({ page }) => {
    await button(page, "放大").click();
    await transition(page);
    const before = await labelAt(page);

    const box = await scene(page).boundingBox();
    const [x, y] = [(box?.x ?? 0) + 300, (box?.y ?? 0) + 400];
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x - 40, y - 30);
    await page.mouse.up();

    await expect.poll(() => labelAt(page)).toEqual([(before?.[0] ?? 0) - 40, (before?.[1] ?? 0) - 30]);
  });

  test("转场以动画进行；开启降低动效后瞬时切换", async ({ page }) => {
    const start = await labelAt(page);
    await button(page, "向右旋转 90°").click();
    expect(await labelAt(page)).toEqual(start); // 时钟暂停，转场尚未推进
    await transition(page);
    const rotated = await labelAt(page);
    expect(rotated).not.toEqual(start);

    await page.getByRole("button", { name: "降低动效" }).click();
    await button(page, "向左旋转 90°").click();

    await expect.poll(() => labelAt(page)).toEqual(start);
  });

  test("转场中断线：立即到位，不再继续（V-U3）", async ({ page }) => {
    await button(page, "向右旋转 90°").click();
    await page.clock.runFor(100);
    const midway = await labelAt(page);

    await sockets[0]?.close({ code: 1011 });
    await expect(page.getByRole("status", { name: "连接状态" })).toHaveText("断线 · 重连中");
    await expect.poll(() => labelAt(page)).not.toEqual(midway);
    const end = await labelAt(page);
    await page.clock.runFor(100); // 不足 1 s，不会重连

    expect(await labelAt(page)).toEqual(end);
  });

  test("浏览器取消手势后结束拖拽", async ({ page }) => {
    await button(page, "放大").click();
    await transition(page);
    const box = await scene(page).boundingBox();
    const [x, y] = [(box?.x ?? 0) + 300, (box?.y ?? 0) + 400];
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.locator("[data-scene]").dispatchEvent("pointercancel");
    const before = await labelAt(page);

    await page.mouse.move(x - 40, y - 30);

    expect(await labelAt(page)).toEqual(before);
    await page.mouse.up();
  });

  test("断线时瞬时切换，不播放转场（C-FE-05）", async ({ page }) => {
    const start = await labelAt(page);
    await sockets[0]?.close({ code: 1011 }); // 时钟暂停，重连不会发生
    await expect(page.getByRole("status", { name: "连接状态" })).toHaveText("断线 · 重连中");

    await button(page, "向右旋转 90°").click();

    await expect.poll(() => labelAt(page)).not.toEqual(start);
    const moved = await labelAt(page);
    await transition(page);
    expect(await labelAt(page)).toEqual(moved); // 已在终点，没有后续转场
  });
});
