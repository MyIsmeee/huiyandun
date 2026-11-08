import { expect, type Page, test } from "@playwright/test";
import { expectNoOverflow, signedIn } from "./helpers";

const POSE = { x: 2, y: 2, height_m: 3, yaw_deg: 45, pitch_deg: -30, hfov_deg: 90, range_m: 15 };
const CAMERA = {
  id: "cam-03", name: "大门口", ip: "192.168.8.31", ingest: "pull",
  source: { protocol: "rtsp", host: "192.168.8.31", port: 554, path: "/Streaming/Channels/101", relay: false },
  username: "admin", password_set: true, pose: POSE, calibration: [], climb_lines: [],
  created_at: "2026-11-05T00:00:00Z", updated_at: "2026-11-05T00:00:00Z",
}; // prettier-ignore
const PUSHED = { ...CAMERA, id: "cam-04", name: "仓库", ip: "192.168.8.32", ingest: "push", source: null, password_set: false };

async function openCameras(page: Page, items: unknown[]): Promise<void> {
  await signedIn(page);
  await page.route("/api/auth/session", (route) => route.fulfill({ json: { username: "admin", role: "admin", expires_at: "2026-11-08T00:00:00Z" } }));
  await page.route("/api/cameras", (route) => route.fulfill({ json: { items } }));
  await page.goto("/");
  await page.getByRole("navigation", { name: "导航" }).getByRole("button", { name: "摄像头" }).click();
}

// 摄像头页（ui.md §7.2）：列表与空态的截图基线（V-P2、V-G3）
test("摄像头列表：拉流与推流各一路", async ({ page }) => {
  await openCameras(page, [CAMERA, PUSHED]);
  await expect(page.getByRole("table", { name: "摄像头列表" }).getByRole("row")).toHaveCount(3);
  await expectNoOverflow(page);
  await expect(page).toHaveScreenshot("cameras.png");
});

test("摄像头列表：空态", async ({ page }) => {
  await openCameras(page, []);
  await expect(page.getByText("还没有摄像头")).toBeVisible();
  await expectNoOverflow(page);
  await expect(page).toHaveScreenshot("cameras-empty.png");
});
