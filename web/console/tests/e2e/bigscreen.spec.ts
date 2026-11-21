import { expect, type Page, test } from "@playwright/test";
import { AREA, camera, mockLlmStatus, mockKpis, mockSocket, SITE } from "./helpers";

// 态势大屏（移植自 MF-TurbineMonitor）：顶栏"大屏"进入，标题栏、左右各三块面板、中央 3D 与底部操作；不做截图基线
const ALERT = {
  schema_version: "1.2.0", event_id: "00000000-0000-4000-8000-000000000020", ts: new Date().toISOString(),
  rule_id: "HYD-NET-0001", rule_version: "3", mode: "enforce", category: "auth_bruteforce",
  severity: "high", src_ip: "172.30.0.100", dst_ip: "172.30.0.12", device_id: "cam-02",
  technique: "T1110", evidence_ref: "suricata:flow/1", source: "rule", confidence: 1,
  summary: "HYD-NET-0001 RTSP authentication brute force",
}; // prettier-ignore

const LOBBY = { ...AREA, id: "area-02", name: "大厅", width_m: 20, depth_m: 16 };
const CAM02 = { ...camera("cyber_alert", "cam-02"), name: "东门", ip: "172.30.0.12" };
const CAM03 = { ...camera("normal", "cam-03"), name: "大厅", camera: { ...camera("normal").camera, area_id: LOBBY.id } };

async function openScreen(page: Page) {
  await page.addInitScript(() => localStorage.setItem("hyd.main", "screen"));
  await page.route("/api/site", (route) =>
    route.fulfill({ json: { ...SITE, areas: [AREA, LOBBY], devices: [camera("normal", "cam-01"), CAM02, CAM03] } }),
  );
  await mockLlmStatus(page);
  await mockKpis(page, {
    online_devices: { value: 3, delta: 0 },
    active_alerts: { value: 1, delta: 1 },
    contained_today: { value: 2, delta: 2 },
    last_contain_ms: { value: 4200, delta: null },
  });
  const sockets = await mockSocket(page);
  await page.goto("/");
  await expect(page.locator(".bs-root")).toHaveAttribute("data-scene", "ready", { timeout: 30_000 });
  return sockets;
}

test("大屏：导航进入，面板齐全，推送的告警进入事件流与滚动通知", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  const [ws] = await openScreen(page);
  await expect(page.getByRole("navigation", { name: "导航" }).getByRole("button", { name: "大屏" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { name: "慧眼盾 · 安全态势大屏" })).toBeVisible();
  for (const name of ["运行指标", "告警趋势 · 近 24 小时", "目标流量 · 每 5 秒", "设备运行", "区域告警分布", "实时事件"]) {
    await expect(page.getByRole("region", { name })).toBeVisible();
  }
  const metrics = page.getByRole("region", { name: "运行指标" });
  await expect(metrics.getByText("活跃告警")).toBeVisible();
  await expect(metrics.locator("li.warn")).toHaveCount(1);
  // 告警中的设备排在设备运行列表最前
  const first = page.getByRole("region", { name: "设备运行" }).locator(".bs-row").first();
  await expect(first).toContainText("东门");
  await expect(first).toContainText("网络攻击");

  ws?.send(JSON.stringify({ channel: "alerts", data: ALERT }));
  const events = page.getByRole("region", { name: "实时事件" });
  await expect(events.getByText("口令暴力破解")).toBeVisible();
  await expect(events.getByText("东门")).toBeVisible();
  await expect(page.locator(".bs-marquee")).toContainText("【最新告警】");
  await page.screenshot({ path: test.info().outputPath("bigscreen-1920.png") });
});

test("大屏：区域展开动画期间按钮不可用；告警巡检只巡检告警中的摄像头", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openScreen(page);
  const explode = page.getByRole("button", { name: "区域展开" });
  await explode.click();
  const collapse = page.getByRole("button", { name: "区域收拢" });
  await expect(collapse).toHaveAttribute("aria-pressed", "true");
  await expect(collapse).toBeDisabled();
  await expect(collapse).toBeEnabled({ timeout: 5_000 });
  await page.screenshot({ path: test.info().outputPath("bigscreen-exploded.png") });

  await page.getByRole("button", { name: "告警巡检" }).click();
  await expect(page.getByRole("status").filter({ hasText: "巡检中" })).toHaveText("巡检中：东门（1/1）");
  await page.waitForTimeout(2500);
  await page.screenshot({ path: test.info().outputPath("bigscreen-patrol.png") });
  await page.getByRole("button", { name: "停止巡检" }).click();
  await expect(page.getByRole("status").filter({ hasText: "巡检中" })).toHaveCount(0);
});

test("大屏：没有区域时中央给出说明，操作按钮不可用", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("hyd.main", "screen"));
  await page.route("/api/site", (route) => route.fulfill({ json: { ...SITE, areas: [], devices: [] } }));
  await mockLlmStatus(page);
  await mockKpis(page);
  await mockSocket(page);
  await page.goto("/");
  await expect(page.getByText("尚未搭建场景区域 · 请在「管理 → 场景」中添加")).toBeVisible();
  await expect(page.getByRole("button", { name: "告警巡检" })).toBeDisabled();
  await expect(page.getByRole("region", { name: "区域告警分布" }).getByText("尚未搭建场景区域")).toBeVisible();
});
