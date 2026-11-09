import { expect, type Page, test } from "@playwright/test";
import { camera, expectNoOverflow, freezeClock, open } from "./helpers";

// ui.md §5.1：DeviceMarker 全部 9 种状态的截图基线（V-P2）
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
    await expect(scene(page)).toHaveScreenshot(`device-${state}.png`);
  });
}

test("单击设备展开详情并连接实时画面，Esc 收起（V-I2、FR-106）", async ({ page }) => {
  const signals: string[] = [];
  await page.route("/api/devices/cam-01/webrtc", (route) => {
    signals.push(route.request().postData() ?? "");
    return route.fulfill({ status: 502, json: { code: "bad_gateway", message: "视频服务不可用", request_id: "r" } });
  });
  await open(page, [camera("uncalibrated")]);

  await page.getByRole("button", { name: "查看 cam-01 详情" }).click();
  const panel = page.getByRole("region", { name: "详情" });
  await expect(panel).toContainText("172.30.0.11");
  await expect(panel.locator('[data-video="unavailable"]')).toContainText("视频服务不可用");
  expect(signals[0]).toMatch(/^v=0/);
  await expectNoOverflow(page);
  await expect(page).toHaveScreenshot("device-detail.png");

  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
});

test("设备状态以推送为准", async ({ page }) => {
  const sockets = await open(page, [camera("normal")]);

  sockets[0]?.send(JSON.stringify({ channel: "devices", data: camera("cyber_alert") }));

  await expect(scene(page).locator('[data-device="cam-01"]')).toContainText("网络攻击");
});

test("同时命中：定位针写明网络攻击与物理告警两种状态（V-U4）", async ({ page }) => {
  await open(page, [camera("both")]);

  await expect(scene(page).locator('[data-device="cam-01"]').getByRole("status")).toHaveText("网络攻击 · 物理告警");
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

/** 告警等级由服务端累计，随设备推送（Device.alert_severity） */
const severity = (alert_severity: string) => ({
  channel: "devices",
  data: { ...camera("cyber_alert"), alert_severity },
});
const changes = (page: Page) => async () => {
  const before = await scene(page).screenshot();
  await page.clock.runFor(250);
  return !(await scene(page).screenshot()).equals(before);
};

test("网络攻击视场只在 critical / high 告警时呼吸（V-A1）", async ({ page }) => {
  const sockets = await open(page, [camera("cyber_alert")]);

  sockets[0]?.send(JSON.stringify(severity("medium")));
  await page.clock.runFor(100);
  expect(await changes(page)()).toBe(false);
  sockets[0]?.send(JSON.stringify(severity("high")));
  await expect.poll(changes(page)).toBe(true);
});

test("网络攻击视场呼吸；断线或降低动效时停止（V-A1、V-U3、V-A4）", async ({ page }) => {
  const sockets = await open(page, [camera("cyber_alert")]);
  sockets[0]?.send(JSON.stringify(severity("critical")));
  await page.clock.runFor(100);

  // 切换后回到静止不透明度需要再绘制一帧：轮询直到画面不再变化
  expect(await changes(page)()).toBe(true);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect.poll(changes(page)).toBe(false);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect.poll(changes(page)).toBe(true);
  await sockets[0]?.close();
  await expect.poll(changes(page)).toBe(false);
});

test("空间态势中选中摄像头：引线连到画面小卡，可跳到监控墙放大该路（V-I6）", async ({ page }) => {
  await page.route(/\/api\/cameras\/.+\/snapshot/, (route) =>
    route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="9"><rect width="16" height="9" fill="#666"/></svg>' }),
  );
  await open(page, [camera("normal")]);
  const callout = scene(page).getByRole("group", { name: "cam-01 画面" });
  await expect(callout).toHaveCount(0);

  await scene(page).getByRole("button", { name: "查看 cam-01 详情" }).click();
  await expect(callout.locator("img")).toBeVisible();
  await expect(scene(page).locator("polyline")).toHaveCount(1);
  await expect(scene(page)).toHaveScreenshot("device-callout.png");

  // 场景变窄时卡片随之左移，引线终点跟着卡片走
  const end = async () => Number((await scene(page).locator("polyline").getAttribute("points"))?.split(/[ ,]/).at(-2));
  const left = async () => {
    const [box, region] = await Promise.all([callout.boundingBox(), scene(page).boundingBox()]);
    return (box?.x ?? 0) - (region?.x ?? 0);
  };
  const before = await left();
  await page.getByRole("button", { name: "展开摄像头栏" }).click();
  await expect.poll(left).toBeLessThan(before);
  await expect.poll(end).toBeCloseTo(await left(), 0);

  await callout.getByRole("button", { name: "在监控墙中查看" }).click();
  await expect(page.getByRole("list", { name: "监控墙" }).getByRole("listitem")).toHaveCount(1);
});
