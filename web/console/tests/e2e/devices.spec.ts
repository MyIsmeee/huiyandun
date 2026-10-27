import { expect, type Page, test } from "@playwright/test";
import { camera, expectNoOverflow, freezeClock, open, zoomIn } from "./helpers";

// HYD-UIX-004 §5.2：DeviceMarker 全部 9 种状态的截图基线（V-P2）
const STATES = [
  ["normal", null],
  ["offline", "离线"],
  ["uncalibrated", "未标定"],
  ["physical_alert", "物理告警"],
  ["cyber_alert", "网络攻击"],
  ["both", "网络攻击"],
  ["pending_action", "处置中"],
  ["contained", "已处置"],
  ["notify_only", "已通知 · 待联动"],
] as const;

const scene = (page: Page) => page.getByRole("region", { name: "场景" });

test.beforeEach(({ page }) => freezeClock(page));

for (const [state, label] of STATES) {
  test(`设备状态：${state}`, async ({ page }) => {
    await open(page, [camera(state)]);

    const tags = scene(page).locator('[data-device="cam-01"]');
    if (label) await expect(tags).toContainText(label);
    else await expect(tags).toHaveCount(0);
    await expectNoOverflow(page);
    await zoomIn(page);
    await expect(scene(page)).toHaveScreenshot(`device-${state}.png`);
  });
}

test("设备状态以推送为准", async ({ page }) => {
  const sockets = await open(page, [camera("normal")]);

  sockets[0]?.send(JSON.stringify({ channel: "devices", data: camera("cyber_alert") }));

  await expect(scene(page).locator('[data-device="cam-01"]')).toContainText("网络攻击");
});

test("同时命中显示网络攻击与物理告警两个标签", async ({ page }) => {
  await open(page, [camera("both")]);

  await expect(scene(page).locator('[data-device="cam-01"] span')).toHaveText(["网络攻击", "物理告警"]);
});

test("总览：演示站点的两台摄像头（V-P3）", async ({ page }) => {
  const at = (id: string, state: string, x: number, y: number, yaw_deg: number) => {
    const device = camera(state, id);
    return { ...device, camera: { ...device.camera, pose: { ...device.camera.pose, x, y, yaw_deg, range_m: 15 } } };
  };
  await open(page, [at("cam-01", "normal", 2, 2, 45), at("cam-02", "cyber_alert", 38, 22, 225)]);

  await expectNoOverflow(page);
  await expect(scene(page)).toHaveScreenshot("device-overview.png");
});

test("网络攻击视场呼吸；断线或降低动效时停止（V-A1、V-U3、V-A4）", async ({ page }) => {
  const sockets = await open(page, [camera("cyber_alert")]);
  const changes = async () => {
    const before = await scene(page).screenshot();
    await page.clock.runFor(250);
    return !(await scene(page).screenshot()).equals(before);
  };

  // 切换后回到静止不透明度需要再绘制一帧：轮询直到画面不再变化
  expect(await changes()).toBe(true);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect.poll(changes).toBe(false);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect.poll(changes).toBe(true);
  await sockets[0]?.close();
  await expect.poll(changes).toBe(false);
});
