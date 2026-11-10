import { expect, type Page, test, type WebSocketRoute } from "@playwright/test";
import { AREA, camera, expectNoOverflow, freezeClock, mockKpis, mockSocket, open, presetMotion, SITE, sceneSettled, signedIn, withoutWebGL2 } from "./helpers";

test.beforeEach(({ page }) => freezeClock(page));

const scene = (page: Page) => page.getByRole("region", { name: "场景" });
const SCENE_CHUNK = "**/assets/Scene3D-*.js";

// 设计 150 §4：空区域只有渐隐地面，不画区域边框、网格，也不自动补墙；提示尚未搭建
test("空区域：只有渐隐地面，提示该区域还没有搭建场景", async ({ page }) => {
  await signedIn(page);
  await page.goto("/");
  await sceneSettled(page);

  await expect(scene(page).getByText("该区域还没有搭建场景")).toBeVisible();
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

  // 降级说明在场景底部（与断线提示、处置进度条同列），不与视角控件重叠
  await expect(page.getByText("2D 视图 · 不支持 WebGL2")).toBeVisible();
  // V-P3：最窄的 1366 宽下，视角控件（右下）不与指标条（左上）重叠
  await page.setViewportSize({ width: 1366, height: 768 });
  const [kpi, toolbar] = await Promise.all([
    page.getByRole("list", { name: "关键指标" }).boundingBox(),
    page.getByRole("toolbar", { name: "视角" }).boundingBox(),
  ]);
  expect((kpi?.y ?? 0) + (kpi?.height ?? 0)).toBeLessThan(toolbar?.y ?? 0);
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
    await presetMotion(page);
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

  // 另一台摄像头装在区域另一角，视差量级与相机距离一致
  const far = { ...camera("normal", "cam-02"), camera: { ...camera("normal").camera, pose: { x: 36, y: 4, height_m: 3, yaw_deg: 135, pitch_deg: -30, hfov_deg: 90, range_m: 6 } } };

  test.beforeEach(async ({ page }) => {
    sockets = await open(page, [camera("uncalibrated"), far]);
  });

  test("旋转 90°，返回总览回到默认机位（V-I5）", async ({ page }) => {
    await button(page, "旋转 90°").click();
    await transition(page);
    await expect(scene(page)).toHaveScreenshot("scene-rotated.png");
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
    await button(page, "旋转 90°").click();
    expect(await labelAt(page)).toEqual(start); // 时钟暂停，转场尚未推进
    await transition(page);
    const rotated = await labelAt(page);
    expect(rotated).not.toEqual(start);

    await page.getByRole("button", { name: "降低动效" }).click();
    await button(page, "返回总览").click();

    await expect.poll(() => labelAt(page)).toEqual(start);
  });

  test("转场中断线：立即到位，不再继续（V-U3）", async ({ page }) => {
    await button(page, "旋转 90°").click();
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

    await button(page, "旋转 90°").click();

    await expect.poll(() => labelAt(page)).not.toEqual(start);
    const moved = await labelAt(page);
    await transition(page);
    expect(await labelAt(page)).toEqual(moved); // 已在终点，没有后续转场
  });
});

// §5.1 L1、§8 PerceivedScene：街道 / 室内 / 未标定 / 陈旧 / 断线。
// D-120、设计 150 §9：当前区域管理员搭建的场景，同一资产的全部实例合并绘制
test.describe("搭建场景", () => {
  /** 少量物体：路、墙、小办公楼、树、一组桌椅（设计 150 §4 要求的"只有少量物体的区域"） */
  const FEW = [
    { asset: "road", x: 0, y: 20, rot: 0, len: 40 },
    { asset: "wall", x: 12, y: 2, rot: 90, len: 8 },
    { asset: "office-small", x: 30, y: 7, rot: 0, len: null },
    { asset: "tree", x: 22, y: 14, rot: 0, len: null },
    { asset: "tree-small", x: 26, y: 15, rot: 0, len: null },
    { asset: "desk", x: 7, y: 10, rot: 90, len: null },
    { asset: "office-chair", x: 8, y: 10, rot: 270, len: null },
  ];
  // 演示站点的 cam-01：位于西北角，朝东南
  const cam01 = (state = "normal") => {
    const device = camera(state);
    const pose = { x: 2, y: 2, height_m: 3, yaw_deg: 45, pitch_deg: -30, hfov_deg: 90, range_m: 15 };
    return { ...device, camera: { ...device.camera, pose } };
  };
  /** 以给定设备与物体打开空间态势，等到场景到达 state；默认降低动效，截图不受转场影响 */
  const furnished = async (
    page: Page,
    devices: object[],
    { items = FEW, webgl2 = true, reduced = true, state = webgl2 ? "ready" : "2d" }: { items?: object[]; webgl2?: boolean; reduced?: boolean; state?: "ready" | "2d" | "error" } = {},
  ) => {
    if (!webgl2) await withoutWebGL2(page);
    await presetMotion(page, reduced);
    await page.route("/api/site", (route) => route.fulfill({ json: { ...SITE, areas: [{ ...AREA, items }], devices } }));
    await mockKpis(page);
    const sockets = await mockSocket(page);
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await sceneSettled(page, state);
    return sockets;
  };

  for (const state of ["normal", "physical_alert", "cyber_alert"]) {
    test(`少量物体的区域：${state}`, async ({ page }) => {
      await furnished(page, [cam01(state)]);

      await expect(scene(page).getByText("该区域还没有搭建场景")).toHaveCount(0);
      await expectNoOverflow(page);
      await expect(scene(page)).toHaveScreenshot(`scene-area-${state}.png`);
    });
  }

  test("实例化渲染：同样几种资产放得再多，绘制调用数不变（V-P1、C-FE-04）", async ({ page }) => {
    await furnished(page, [cam01()]);
    const few = await page.evaluate(() => window.__hydDrawCalls?.());

    const many = [...FEW];
    for (let x = 4; x < 36; x += 4) for (const y of [4, 12]) many.push({ asset: "desk", x, y, rot: 0, len: null }, { asset: "tree", x, y: y + 2, rot: 0, len: null });
    await page.route("/api/site", (route) => route.fulfill({ json: { ...SITE, areas: [{ ...AREA, items: many }], devices: [cam01()] } }));
    await page.reload();
    await page.waitForLoadState("networkidle");
    await sceneSettled(page);

    expect(few).toBeGreaterThan(0);
    expect(await page.evaluate(() => window.__hydDrawCalls?.())).toBe(few);
  });

  test("打开时一次加载整个资产库：之后放入新类别的物体不再加载模型，场景不闪空", async ({ page }) => {
    const models = new Set<string>();
    page.on("request", (req) => {
      const name = new URL(req.url()).pathname.match(/\/models\/(scene-[a-z]+\.glb)$/)?.[1];
      if (name) models.add(name);
    });
    await furnished(page, [cam01()]);

    const catalog = (await (await page.request.get("/models/catalog.json")).json()) as { assets: { file: string }[] };
    expect([...models].sort()).toEqual([...new Set(catalog.assets.map((a) => a.file))].sort());
  });

  // 资产目录或模型文件取不到时（如部署缺文件），由场景的错误边界提示，可重新加载
  for (const [name, url] of [
    ["资产目录", "/models/catalog.json"],
    ["模型文件", "**/models/scene-building.glb"],
  ] as const) {
    test(`${name}加载失败时提示并可重新加载`, async ({ page }) => {
      await page.route(url, (route) => route.fulfill({ status: 500 }));
      await furnished(page, [cam01()], { state: "error" });

      await expect(scene(page).getByText("场景加载失败")).toBeVisible();
      await expect(scene(page).getByRole("button", { name: "重新加载" })).toBeVisible();
    });
  }

  test("2D 降级视图中资产目录加载失败时同样提示并可重新加载", async ({ page }) => {
    await page.route("/models/catalog.json", (route) => route.fulfill({ status: 500 }));
    await furnished(page, [cam01()], { webgl2: false, state: "error" });

    await expect(scene(page).getByText("场景加载失败")).toBeVisible();
    await expect(scene(page).getByRole("button", { name: "重新加载" })).toBeVisible();
  });

  test("没有任何区域：提示还没有场景区域", async ({ page }) => {
    await page.route("/api/site", (route) => route.fulfill({ json: { ...SITE, areas: [], devices: [cam01()] } }));
    await mockKpis(page);
    await mockSocket(page);
    await page.goto("/");
    await sceneSettled(page);

    await expect(scene(page).getByText("还没有场景区域")).toBeVisible();
    await expect(scene(page).getByRole("button", { name: "查看 cam-01 详情" })).toHaveCount(0); // 摄像头不在任何区域，不出现
  });

  // V-I1：双击摄像头，镜头站到摄像头位置沿其朝向看出去；"返回总览"回到默认机位
  test("双击摄像头：摄像头视角；返回总览", async ({ page }) => {
    await furnished(page, [cam01()]);
    const picker = scene(page).getByRole("button", { name: "查看 cam-01 详情" });

    await picker.dblclick();
    await page.clock.runFor(100);
    await expect(picker).toHaveCount(0); // 视点就在机头处
    await expect(page.getByRole("region", { name: "详情" }).getByRole("heading", { level: 2 })).toHaveText("cam-01");
    await expect(scene(page)).toHaveScreenshot("scene-camera-view.png");

    await page.getByRole("toolbar", { name: "视角" }).getByRole("button", { name: "返回总览" }).click();
    await page.clock.runFor(100);
    await expect(picker).toBeVisible();
    await expect(page.getByRole("toolbar", { name: "视角" }).getByRole("button", { name: "放大" })).toBeEnabled();
  });

  test("飞入摄像头视角途中断线：立即到位，不再继续（V-U3）", async ({ page }) => {
    const [ws] = await furnished(page, [cam01("cyber_alert")], { reduced: false });
    // 只看设备上方的定位针：检查栏详情也写着状态
    const tag = scene(page).locator('[data-device="cam-01"]');
    await expect(tag.getByText("网络攻击")).toBeVisible();

    await scene(page).getByRole("button", { name: "查看 cam-01 详情" }).dblclick();
    await expect(tag).toHaveCount(0); // 视点一侧的摄像头不画，状态标签随之不画，不悬空
    await page.clock.runFor(100); // 飞行途中
    await ws?.close({ code: 1011 });
    await expect(page.getByRole("status", { name: "连接状态" })).toHaveText("断线 · 重连中");
    await page.clock.runFor(16);

    await expect(scene(page)).toHaveScreenshot("scene-camera-view-offline.png"); // 已在机头处，与 scene-camera-view 取景一致
    const end = await scene(page).screenshot();
    await page.clock.runFor(600);
    expect(await scene(page).screenshot()).toEqual(end); // 没有后续飞行
  });

  test("断线：场景保留并降饱和（V-U3）", async ({ page }) => {
    const [ws] = await furnished(page, [cam01()]);

    await page.routeWebSocket("/ws", (route) => route.close());
    await ws?.close();
    await expect(page.getByRole("status", { name: "断线提示" })).toHaveText(/^数据非实时/);
    await page.clock.runFor(100);
    await expect(scene(page)).toHaveClass(/saturate-50/);
    await expect(scene(page)).toHaveScreenshot("scene-disconnected.png");
  });

  test("无 WebGL2 时 2D 俯视视图绘制物体占地、摄像头视场与人员（C-FE-08、#60）", async ({ page }) => {
    const sockets = await furnished(page, [cam01()], { webgl2: false });
    const track = { camera_id: "cam-01", track_id: 1, object_class: "person", x: 8, y: 7, uncertainty_m: 0.3, heading_deg: null, speed_mps: null, bbox: [0.4, 0.3, 0.5, 0.8], keypoints: null };
    sockets[0]?.send(JSON.stringify({ channel: "tracks", data: { schema_version: "1.0.0", event_id: "00000000-0000-4000-8000-000000000001", ts: "2026-10-27T06:30:00Z", ...track } }));
    await page.clock.runFor(100);

    await expect(scene(page)).toHaveScreenshot("scene-2d-elements.png");

    // 断线：保留并降饱和（V-U3、V-G3）
    await page.routeWebSocket("/ws", (route) => route.close());
    await sockets[0]?.close();
    await expect(page.getByRole("status", { name: "断线提示" })).toHaveText(/^数据非实时/);
    await expect(scene(page)).toHaveClass(/saturate-50/);
    await expect(scene(page)).toHaveScreenshot("scene-2d-disconnected.png");
  });
});
