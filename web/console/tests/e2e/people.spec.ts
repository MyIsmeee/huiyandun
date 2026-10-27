import { expect, type Page, test, type WebSocketRoute } from "@playwright/test";
import { camera, expectNoOverflow, freezeClock, open, zoomIn } from "./helpers";

// HYD-UIX-004 §8 PersonAvatar：正常 / 告警 / 高误差；V-U4 事件卡
const BASE = { schema_version: "1.0.0", event_id: "00000000-0000-4000-8000-000000000000", ts: "2026-10-27T06:30:00Z" };
const scene = (page: Page) => page.getByRole("region", { name: "场景" });

/** 推送一个人员 2 s 内的 5 个位置（每 500 ms 一次，FR-102），留下一段轨迹 */
async function walk(page: Page, ws: WebSocketRoute | undefined, uncertainty_m: number) {
  for (let i = 0; i < 5; i += 1) {
    const track = { ...BASE, camera_id: "cam-01", track_id: 7, x: 17 + i * 0.6, y: 12 - i * 0.3, uncertainty_m };
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

for (const [name, uncertainty_m] of [
  ["normal", 0.4],
  ["uncertain", 1.5],
] as const) {
  test(`人员化身：${name}`, async ({ page }) => {
    const [ws] = await open(page, [camera("normal")]);
    await zoomIn(page);
    await walk(page, ws, uncertainty_m);

    await expect(scene(page)).toHaveScreenshot(`person-${name}.png`);
  });
}

test("跌倒：化身转物理告警，摄像头旁弹出事件卡（V-U4）", async ({ page }) => {
  const [ws] = await open(page, [camera("normal")]);
  await walk(page, ws, 0.4);
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
  const [ws] = await open(page, [camera("normal")]);
  await zoomIn(page);
  await walk(page, ws, 0.4);
  const before = await scene(page).screenshot();

  await page.clock.runFor(2500);

  expect(await scene(page).screenshot()).not.toEqual(before);
  await expect(scene(page)).toHaveScreenshot("device-zoomed-empty.png");
});

test("断线：化身与事件卡保留，场景降饱和并提示数据非实时（V-U3、V-U4）", async ({ page }) => {
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
  const [ws] = await open(page, [camera("normal")]);
  await zoomIn(page);
  const at = (x: number) => ({ ...BASE, camera_id: "cam-01", track_id: 7, x, y: 12, uncertainty_m: 0.4 });
  // 首次出现在视口外：three 按首次位置计算实例的包围球，之后若不重算，走入视口也会被剔除
  ws?.send(JSON.stringify({ channel: "tracks", data: at(4) }));
  await page.clock.runFor(500);
  ws?.send(JSON.stringify({ channel: "tracks", data: at(18) }));
  await page.clock.runFor(500);

  await expect(scene(page)).toHaveScreenshot("person-walk-in.png");
});
