import { expect, type Page, test, type WebSocketRoute } from "@playwright/test";
import { camera, expectNoOverflow, freezeClock, open, presetTheme, zoomIn } from "./helpers";

// HYD-UIX-004 §8 TargetModels：人员 / 各类车辆 / 告警 / 高误差；V-U4 事件卡
const BASE = { schema_version: "1.0.0", event_id: "00000000-0000-4000-8000-000000000000", ts: "2026-10-27T06:30:00Z" };
/** 1.7 m 人员站立时 COCO 17 点相对脚点的横向偏移与高度（米），画面右侧为正 */
const STANDING: [number, number][] = [
  [0, 1.58],
  [-0.03, 1.62],
  [0.03, 1.62],
  [-0.07, 1.6],
  [0.07, 1.6],
  [-0.19, 1.4],
  [0.19, 1.4],
  [-0.22, 1.08],
  [0.22, 1.08],
  [-0.22, 0.82],
  [0.22, 0.82],
  [-0.1, 0.9],
  [0.1, 0.9],
  [-0.1, 0.5],
  [0.1, 0.5],
  [-0.1, 0.08],
  [0.1, 0.08],
];
/** 双手举过头顶：肘与腕抬高 */
const RAISED = STANDING.map(([side, height], i): [number, number] => (i >= 7 && i <= 10 ? [side * 1.1, i <= 8 ? 1.7 : 1.98] : [side, height]));

/** 画到 16:9 画面上，人高约占画面三成；rotate 为画面内旋转（跌倒为 90°）；检测框底边为最低关键点 */
function pose(points: [number, number][], rotate = 0) {
  const [c, s, k] = [Math.cos(rotate), Math.sin(rotate), 0.3 / 1.7];
  const keypoints = points.map(([side, h]) => [0.45 + ((side * c + h * s) * k * 9) / 16, 0.8 - (h * c - side * s) * k, 0.9]);
  const us = keypoints.map(([u = 0]) => u);
  const vs = keypoints.map(([, v = 0]) => v);
  return { bbox: [Math.min(...us), Math.min(...vs) - 0.02, Math.max(...us), Math.max(...vs)], keypoints };
}

/** track 1.1 的新增字段；人员默认站立、无朝向（静止或起步） */
const TARGET = { object_class: "person", heading_deg: null, speed_mps: null, ...pose(STANDING) };
const scene = (page: Page) => page.getByRole("region", { name: "场景" });

/** 推送一个人员 2 s 内的 5 个位置（每 500 ms 一次，FR-102），留下一段轨迹 */
async function walk(page: Page, ws: WebSocketRoute | undefined, uncertainty_m: number) {
  for (let i = 0; i < 5; i += 1) {
    const track = { ...BASE, ...TARGET, camera_id: "cam-01", track_id: 7, x: 17 + i * 0.6, y: 12 - i * 0.3, uncertainty_m };
    ws?.send(JSON.stringify({ channel: "tracks", data: track }));
    await page.clock.runFor(500);
  }
}

const fall = {
  ...BASE,
  camera_id: "cam-01",
  track_id: 7,
  behavior: "fall",
  confidence_avg: 0.9,
  duration_s: 2,
  ts_start: "2026-10-27T06:29:58Z",
  ts_end: "2026-10-27T06:30:00Z",
};

test.beforeEach(({ page }) => freezeClock(page));

/**
 * 截图用例一律开启降低动效：目标直接停在最新实测位置（V-A4）。暂停的时钟下每次推进会连续绘制全部插值帧，
 * 软件渲染（SwiftShader）并行运行时来不及完成截图；两次实测之间的插值与转向由单元测试 scene-targets 覆盖
 */
const still = (page: Page) => presetTheme(page, "dark", true);

for (const [name, uncertainty_m] of [
  ["normal", 0.4],
  ["uncertain", 1.5],
] as const) {
  test(`人员化身：${name}`, async ({ page }) => {
    await still(page);
    const [ws] = await open(page, [camera("normal")]);
    await zoomIn(page);
    await walk(page, ws, uncertainty_m);

    await expect(scene(page)).toHaveScreenshot(`person-${name}.png`);
  });
}

test("跌倒：化身转物理告警，摄像头旁弹出事件卡（V-U4）", async ({ page }) => {
  await still(page);
  const [ws] = await open(page, [camera("normal")]);
  await walk(page, ws, 0.4);
  const fallen = { ...BASE, ...TARGET, ...pose(STANDING, Math.PI / 2), camera_id: "cam-01", track_id: 7, x: 19.4, y: 10.8, uncertainty_m: 0.4 };
  ws?.send(JSON.stringify({ channel: "tracks", data: fallen }));
  ws?.send(JSON.stringify({ channel: "alerts", data: fall }));
  ws?.send(JSON.stringify({ channel: "devices", data: camera("physical_alert") }));

  const card = scene(page).getByRole("status");
  await expect(card).toHaveText("物理告警 · 跌倒cam-01 · 14:29:58");
  await expectNoOverflow(page);
  await zoomIn(page);
  await expect(scene(page)).toHaveScreenshot("person-alert.png");

  ws?.send(JSON.stringify({ channel: "devices", data: camera("normal") }));
  await expect(card).toHaveCount(0);
});

test("2 s 无位置更新即移除化身（V-U4）", async ({ page }) => {
  await still(page);
  const [ws] = await open(page, [camera("normal")]);
  await zoomIn(page);
  await walk(page, ws, 0.4);
  const before = await scene(page).screenshot();

  await page.clock.runFor(2500);

  expect(await scene(page).screenshot()).not.toEqual(before);
  await expect(scene(page)).toHaveScreenshot("device-zoomed-empty.png");
});

test("断线：化身与事件卡保留，场景降饱和并提示数据非实时（V-U3、V-U4）", async ({ page }) => {
  await still(page);
  const [ws] = await open(page, [camera("normal")]);
  await zoomIn(page);
  await walk(page, ws, 0.4);
  ws?.send(JSON.stringify({ channel: "alerts", data: fall }));
  ws?.send(JSON.stringify({ channel: "devices", data: camera("physical_alert") }));
  await expect(scene(page).getByRole("status")).toBeVisible();

  // 服务端不可达：之后的重连一律被关闭，连接保持断开
  await page.routeWebSocket("/ws", (route) => route.close());
  await ws?.close();
  const notice = scene(page).getByText(/^数据非实时 · 最后更新 \d{2}:\d{2}:\d{2}$/);
  await expect(notice).toBeVisible();
  await page.clock.runFor(100); // 时钟暂停：推进一帧，使 3D 场景绘制告警态
  const before = await scene(page).screenshot();
  await page.clock.runFor(2500); // 超过 2 s 无更新：在线时会移除化身

  // 仍断线且画面不变即化身仍在：在线时同样的等待会使化身消失（见上一用例）
  await expect(notice).toBeVisible();
  expect((await scene(page).screenshot()).equals(before)).toBe(true);
  await expect(scene(page)).toHaveClass(/saturate-50/);
  await expect(scene(page).getByRole("status")).toBeVisible();
  await expect(scene(page)).toHaveScreenshot("person-disconnected.png");
});

test("放大后人员从视口外走入，化身可见（FR-102）", async ({ page }) => {
  await still(page);
  const [ws] = await open(page, [camera("normal")]);
  await zoomIn(page);
  const at = (x: number) => ({ ...BASE, ...TARGET, camera_id: "cam-01", track_id: 7, x, y: 12, uncertainty_m: 0.4 });
  // 首次出现在视口外：three 按首次位置计算实例的包围球，之后若不重算，走入视口也会被剔除
  ws?.send(JSON.stringify({ channel: "tracks", data: at(4) }));
  await page.clock.runFor(500);
  ws?.send(JSON.stringify({ channel: "tracks", data: at(18) }));
  await page.clock.runFor(500);

  await expect(scene(page)).toHaveScreenshot("person-walk-in.png");
});

test("人员与车辆：按类别显示模型，沿运动方向朝向（FR-102）", async ({ page }) => {
  await still(page);
  const [ws] = await open(page, [camera("normal")]);
  await zoomIn(page);
  // 每 200 ms 一次实测（5 FPS）：轿车与自行车向 +x、公交向 +y、货车向 -y、摩托车向 -x、人员斜向行走
  const movers = [
    { track_id: 1000001, object_class: "car", x: 12, y: 8, dx: 1, dy: 0, heading_deg: 0 },
    { track_id: 1000002, object_class: "bus", x: 22, y: 6, dx: 0, dy: 0.8, heading_deg: 90 },
    { track_id: 1000003, object_class: "motorcycle", x: 24, y: 15, dx: -1.2, dy: 0, heading_deg: 180 },
    { track_id: 1000004, object_class: "truck", x: 12, y: 19, dx: 0, dy: -0.8, heading_deg: 270 },
    { track_id: 1000005, object_class: "bicycle", x: 19, y: 18, dx: 0.8, dy: 0, heading_deg: 0 },
    { track_id: 7, object_class: "person", x: 16, y: 14, dx: 0.25, dy: -0.15, heading_deg: 329 },
  ];
  for (let i = 0; i < 6; i += 1) {
    for (const { dx, dy, x, y, ...m } of movers) {
      const data = { ...BASE, ...TARGET, ...m, camera_id: "cam-01", x: x + dx * i, y: y + dy * i, uncertainty_m: 0.4 };
      ws?.send(JSON.stringify({ channel: "tracks", data }));
    }
    await page.clock.runFor(200);
  }

  await expect(scene(page)).toHaveScreenshot("targets-mixed.png");
});

test("姿态人形：站立、抬手、跌倒与画面姿态一致（FR-109）", async ({ page }) => {
  await still(page);
  const [ws] = await open(page, [camera("normal")]);
  await zoomIn(page);
  const people = [
    { track_id: 1, x: 17, y: 12, ...pose(STANDING) },
    { track_id: 2, x: 18.2, y: 11.4, ...pose(RAISED) },
    { track_id: 3, x: 19.4, y: 10.8, ...pose(STANDING, Math.PI / 2) },
  ];
  for (const p of people) ws?.send(JSON.stringify({ channel: "tracks", data: { ...BASE, ...TARGET, ...p, camera_id: "cam-01", uncertainty_m: 0.4 } }));
  await page.clock.runFor(500);
  // 人形朝向摄像头：转到摄像头一侧观看，三种姿态都能看清
  await page.getByRole("button", { name: "向右旋转 90°" }).click();
  await page.clock.runFor(600);

  await expect(scene(page)).toHaveScreenshot("person-poses.png");
});
