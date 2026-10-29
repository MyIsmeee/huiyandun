import { expect, type Page, test, type WebSocketRoute } from "@playwright/test";
import { camera, expectNoOverflow, freezeClock, mockSocket, open, presetTheme, SITE, sceneSettled, signedIn } from "./helpers";
import { SCENES } from "./scenes";

test.beforeEach(({ page }) => freezeClock(page));

const scene = (page: Page) => page.getByRole("region", { name: "场景" });
const SCENE_CHUNK = "**/assets/Scene3D-*.js";
/** 模拟浏览器不支持 WebGL2：场景降级为 2D 俯视视图（C-FE-08） */
const withoutWebGL2 = (page: Page) =>
  page.addInitScript(() => {
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, id: string, ...rest: unknown[]) {
      return id === "webgl2" ? null : getContext.call(this, id, ...(rest as []));
    } as typeof getContext;
  });

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
  await withoutWebGL2(page);
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

    await expect(scene(page)).toHaveScreenshot("scene-overview.png");
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

    // 透视：与取景中心同深度的内容随指针移动；标签在机头上方，与之深度不同，视差不超过 2 像素
    const drift = async () => {
      const [x = 0, y = 0] = (await labelAt(page)) ?? [];
      return Math.max(Math.abs(x - ((before?.[0] ?? 0) - 40)), Math.abs(y - ((before?.[1] ?? 0) - 30)));
    };
    await expect.poll(drift).toBeLessThanOrEqual(2);
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

// §5.1 L1、§8 PerceivedScene：街道 / 室内 / 未标定 / 陈旧 / 断线。
// SCENES 由 TK-118 的演示帧分割快照（services/vision-engine/tests/scenes/street-1、indoor-1）
// 按演示站点 cam-01 的标定投影得到；快照不含图像，因而没有路面标线，标线与树另以 ELEMENTS 构造
test.describe("感知场景", () => {
  const BASE = { schema_version: "1.0.0", event_id: "00000000-0000-4000-8000-000000000000", camera_id: "cam-01" };
  const EMPTY = { surfaces: [], walls: [], objects: [], trees: [], markings: [] };
  const ELEMENTS = {
    ...EMPTY,
    surfaces: [
      { class: "road", polygon: [[3, 3], [14, 3], [14, 9], [3, 9]] },
      { class: "sidewalk", polygon: [[3, 9], [14, 9], [14, 11], [3, 11]] },
      { class: "grass", polygon: [[3, 11], [14, 11], [14, 15], [3, 15]] },
    ],
    markings: [
      ...[4, 5, 6, 7].map((y) => ({ class: "crosswalk", polygon: [[5, y], [7, y], [7, y + 0.5], [5, y + 0.5]] })),
      { class: "lane", polygon: [[9, 5.9], [13, 5.9], [13, 6.1], [9, 6.1]] },
    ],
    walls: [{ class: "railing", line: [[3, 11], [14, 11]], height_m: 1 }],
    objects: [{ class: "street_furniture", polygon: [[8, 9.5], [9.5, 9.5], [9.5, 9.9], [8, 9.9]], height_m: 0.8 }],
    trees: [{ x: 5, y: 13, height_m: 5 }, { x: 10, y: 13.5, height_m: 5 }, { x: 12.5, y: 12.5, height_m: 1 }],
  };
  // 演示站点的 cam-01：位于西北角，朝东南
  const cam01 = (state = "normal", calibrated = true) => {
    const device = camera(state);
    const pose = { x: 2, y: 2, height_m: 3, yaw_deg: 45, pitch_deg: -30, hfov_deg: 90, range_m: 15 };
    return { ...device, camera: { ...device.camera, pose, calibration: calibrated ? device.camera.calibration : [] } };
  };
  const push = (ws: WebSocketRoute | undefined, frame: object, ts = "2026-10-27T06:30:00Z") =>
    ws?.send(JSON.stringify({ channel: "scene", data: { ...BASE, ts, ...frame } }));
  /** 推送后推进一帧，使 3D 场景绘制新识别结果 */
  const shown = async (page: Page, ws: WebSocketRoute | undefined, frame: object, ts?: string) => {
    push(ws, frame, ts);
    await page.clock.runFor(100);
  };

  for (const [name, frame, theme] of [
    ["street", "street", "light"],
    ["street-dark", "street", "dark"],
    ["indoor", "indoor", "light"],
  ] as const) {
    test(`${name}`, async ({ page }) => {
      await presetTheme(page, theme, true);
      const [ws] = await open(page, [cam01()]);
      await shown(page, ws, SCENES[frame]);

      await expectNoOverflow(page);
      await expect(scene(page)).toHaveScreenshot(`scene-${name}.png`);
    });
  }

  test("地面色块、斑马线与车道线、栏杆、长椅与树", async ({ page }) => {
    await presetTheme(page, "light", true);
    const [ws] = await open(page, [cam01()]);
    await shown(page, ws, ELEMENTS);

    await expect(scene(page)).toHaveScreenshot("scene-elements.png");
  });

  test("未标定摄像头不重建环境，只显示设备与未标定提示（V-U2）", async ({ page }) => {
    await presetTheme(page, "light", true);
    const [ws] = await open(page, [cam01("uncalibrated", false)]);
    const before = await scene(page).screenshot();
    await shown(page, ws, ELEMENTS);

    await expect(scene(page).getByText("未标定")).toBeVisible();
    expect((await scene(page).screenshot()).equals(before)).toBe(true);
  });

  test("场景帧的 ts 早于 10 s 前即弱化显示：补推的旧帧立即弱化，新帧超过 10 s 未更新同样弱化", async ({ page }) => {
    await presetTheme(page, "light", true);
    const [ws] = await open(page, [cam01()]);
    await shown(page, ws, ELEMENTS, "2026-10-27T06:29:40Z");
    await expect(scene(page)).toHaveScreenshot("scene-stale.png");

    await shown(page, ws, ELEMENTS);
    const fresh = await scene(page).screenshot();
    await page.clock.runFor(9_000);
    expect((await scene(page).screenshot()).equals(fresh)).toBe(true);
    await page.clock.runFor(2_000);
    await expect(scene(page)).toHaveScreenshot("scene-stale.png");
  });

  test("新识别帧渐变替换；开启降低动效后瞬时替换（§5.1 L1、V-A4）", async ({ page }) => {
    await presetTheme(page, "light");
    const [ws] = await open(page, [cam01()]);
    await shown(page, ws, ELEMENTS);
    const before = await scene(page).screenshot();

    await shown(page, ws, SCENES.street);
    const midway = await scene(page).screenshot();
    await page.clock.runFor(400);
    const after = await scene(page).screenshot();

    expect(midway.equals(before) || midway.equals(after)).toBe(false);
    await page.getByRole("button", { name: "降低动效" }).click();
    await shown(page, ws, ELEMENTS);
    expect((await scene(page).screenshot()).equals(before)).toBe(true);
  });

  test("断线：保留最后一帧场景并降饱和（V-U3）", async ({ page }) => {
    await presetTheme(page, "light", true);
    const [ws] = await open(page, [cam01()]);
    await shown(page, ws, ELEMENTS);

    await page.routeWebSocket("/ws", (route) => route.close());
    await ws?.close();
    await expect(scene(page).getByText(/^数据非实时/)).toBeVisible();
    await page.clock.runFor(100);
    await expect(scene(page)).toHaveClass(/saturate-50/);
    await expect(scene(page)).toHaveScreenshot("scene-disconnected.png");
  });

  test("无 WebGL2 时 2D 俯视视图同样绘制感知场景（C-FE-08）", async ({ page }) => {
    await withoutWebGL2(page);
    await presetTheme(page, "light", true);
    await page.route("/api/site", (route) => route.fulfill({ json: { ...SITE, devices: [cam01()] } }));
    const sockets = await mockSocket(page); // 页面连上后才有服务端一侧
    await page.goto("/");
    await sceneSettled(page, "2d");
    await shown(page, sockets[0], ELEMENTS);

    await expect(scene(page)).toHaveScreenshot("scene-2d-elements.png");

    // 断线：保留最后一帧场景并降饱和（V-U3、V-G3）
    await page.routeWebSocket("/ws", (route) => route.close());
    await sockets[0]?.close();
    await expect(scene(page).getByText(/^数据非实时/)).toBeVisible();
    await expect(scene(page)).toHaveClass(/saturate-50/);
    await expect(scene(page)).toHaveScreenshot("scene-2d-disconnected.png");
  });
});
