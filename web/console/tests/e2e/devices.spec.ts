import { expect, type Page, test } from "@playwright/test";
import { expectNoOverflow, freezeClock, mockSocket, SITE, sceneSettled } from "./helpers";

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

const camera = (state: string, id = "cam-01") => ({
  id,
  type: "camera",
  ip: "172.30.0.11",
  mode: "host_probe",
  state,
  camera: {
    stream: id,
    pose: { x: 16, y: 14, height_m: 3, yaw_deg: 300, pitch_deg: -30, hfov_deg: 90, range_m: 6 },
    calibration: [],
    homography: null,
    reproj_error_m: null,
  },
});

const scene = (page: Page) => page.getByRole("region", { name: "场景" });

async function open(page: Page, devices: object[]) {
  await page.route("/api/site", (route) => route.fulfill({ json: { ...SITE, devices } }));
  const sockets = await mockSocket(page);
  await page.goto("/");
  await sceneSettled(page);
  return sockets;
}

/** 放大到设备清晰可辨；放大后区域名称移出视口，文字溢出检查须在此之前（V-P3） */
async function zoomIn(page: Page) {
  for (let i = 0; i < 3; i += 1) await page.getByRole("button", { name: "放大" }).click();
  await page.clock.runFor(600);
}

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
