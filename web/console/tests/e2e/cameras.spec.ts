import { expect, type Page, test } from "@playwright/test";
import { expectNoOverflow, openAdmin, signedIn } from "./helpers";

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
  await openAdmin(page, "摄像头");
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

// 管理页外框（设计 150 §9A）：顶栏"管理"进入，左侧栏切换管理页，可收起为图标栏
test("管理页侧栏：切换页面、标示当前项、收起为图标栏", async ({ page }) => {
  await page.route("/api/llm/providers", (route) => route.fulfill({ json: { items: [] } }));
  await page.route("/api/llm/settings", (route) => route.fulfill({ json: { block_public: false } }));
  await openCameras(page, [CAMERA]);
  const sidebar = page.getByRole("navigation", { name: "管理" });
  await expect(page.getByRole("navigation", { name: "导航" }).getByRole("button", { name: "管理" })).toHaveAttribute("aria-current", "page");
  await expect(sidebar.getByRole("button", { name: "摄像头" })).toHaveAttribute("aria-current", "page");

  await sidebar.getByRole("button", { name: "模型供应商" }).click();
  await expect(page.getByRole("region", { name: "模型供应商" })).toBeVisible();
  await expect(page.getByRole("region", { name: "摄像头" })).toHaveCount(0);

  await page.getByRole("button", { name: "收起或展开侧栏" }).click();
  await expect(sidebar.getByText("模型供应商")).toBeHidden();
  await expectNoOverflow(page);
  await expect(page).toHaveScreenshot("admin-sidebar-collapsed.png");

  await page.getByRole("navigation", { name: "导航" }).getByRole("button", { name: "态势" }).click();
  await expect(sidebar).toHaveCount(0);
});

test("管理页盖在监控墙之上时，返回回到监控墙", async ({ page }) => {
  await openCameras(page, [CAMERA]);
  const nav = page.getByRole("navigation", { name: "导航" });
  await nav.getByRole("button", { name: "监控墙" }).click();
  await nav.getByRole("button", { name: "管理" }).click();
  await page.getByRole("region", { name: "摄像头" }).getByRole("button", { name: "返回" }).click();
  await expect(nav.getByRole("button", { name: "监控墙" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("navigation", { name: "管理" })).toHaveCount(0);
});
