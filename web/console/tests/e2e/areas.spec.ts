import { expect, type Page, test } from "@playwright/test";
import { AREA, camera, expectNoOverflow, freezeClock, mockKpis, mockLlmStatus, mockSocket, presetMotion, SITE, sceneSettled } from "./helpers";

// 态势页区域切换与告警胶囊（设计 150 §3、D-124）
test.beforeEach(async ({ page }) => {
  await presetMotion(page, true);
  await freezeClock(page);
});

const HALL = { ...AREA, id: "area-01", name: "一号楼大厅" };
const ROOM = { ...AREA, id: "area-02", name: "二号楼机房" };
const inArea = (device: ReturnType<typeof camera>, area_id: string) => ({ ...device, camera: { ...device.camera, area_id } });
const CAM01 = inArea(camera("normal", "cam-01"), HALL.id);
const CAM02 = inArea({ ...camera("cyber_alert", "cam-02"), ip: "172.30.0.12" }, ROOM.id);

const ALERT = {
  schema_version: "1.2.0", event_id: "00000000-0000-4000-8000-000000000010", ts: "2026-10-27T06:29:10Z",
  rule_id: "HYD-NET-0001", rule_version: "3", mode: "enforce", category: "auth_bruteforce",
  severity: "high", src_ip: "172.30.0.100", dst_ip: "172.30.0.12", device_id: "cam-02",
  technique: "T1110", evidence_ref: "suricata:flow/1", source: "rule", confidence: 1,
  summary: "HYD-NET-0001 RTSP authentication brute force",
}; // prettier-ignore

async function openAreas(page: Page) {
  await page.route("/api/site", (route) => route.fulfill({ json: { ...SITE, areas: [HALL, ROOM], devices: [CAM01, CAM02] } }));
  await mockLlmStatus(page);
  await mockKpis(page);
  const sockets = await mockSocket(page);
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await sceneSettled(page);
  return sockets;
}

const switcher = (page: Page) => page.getByRole("button", { name: /^区域：/ });
const side = (page: Page) => page.getByRole("complementary", { name: "告警与详情" });

test("首次进入显示有告警的区域；下拉中有告警的置顶并标出设备数，其他区域的告警标在按钮上", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 }); // 指标卡与区域切换同处一行最拥挤的情形
  await openAreas(page);
  await expect(switcher(page)).toHaveAccessibleName("区域：二号楼机房");

  await switcher(page).click();
  const items = page.getByRole("menuitemradio");
  await expect(items).toHaveText([/二号楼机房/, /一号楼大厅/]);
  await expect(items.first().getByRole("img", { name: "网络攻击 1 台" })).toBeVisible();
  await expectNoOverflow(page);
  await expect(page.getByRole("menu")).toHaveScreenshot("area-menu.png");

  await items.filter({ hasText: "一号楼大厅" }).click();
  await expect(switcher(page)).toHaveAccessibleName("区域：一号楼大厅");
  await expect(switcher(page).getByRole("group", { name: "其他区域" }).getByRole("img", { name: "网络攻击 1 台" })).toBeVisible();
  await sceneSettled(page);
  // 卡片互不重叠（设计 150 §3）
  const boxes = await Promise.all([page.getByRole("list", { name: "关键指标" }), switcher(page), side(page)].map((l) => l.boundingBox()));
  if (boxes.some((b) => !b)) throw new Error("卡片未显示");
  for (const [i, a] of (boxes as NonNullable<(typeof boxes)[number]>[]).entries())
    for (const b of (boxes as NonNullable<(typeof boxes)[number]>[]).slice(i + 1)) expect(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y).toBe(true);
  await expect(page).toHaveScreenshot("area-switched.png");
});

test("点选另一区域摄像头的告警：切到该区域并显示详情；新告警不自动切换", async ({ page }) => {
  const [ws] = await openAreas(page);
  await switcher(page).click();
  await page.getByRole("menuitemradio", { name: /一号楼大厅/ }).click();
  ws?.send(JSON.stringify({ channel: "alerts", data: ALERT }));
  await expect(side(page).getByRole("button", { name: /HYD-NET-0001/ })).toBeVisible();
  await expect(switcher(page)).toHaveAccessibleName("区域：一号楼大厅");

  await side(page).getByRole("button", { name: /HYD-NET-0001/ }).click();
  await expect(switcher(page)).toHaveAccessibleName("区域：二号楼机房");
  await expect(side(page).getByRole("heading", { name: "cam-02" })).toBeVisible();
});

test("告警卡收起为带计数的胶囊；选中设备时仍显示详情，返回后回到胶囊", async ({ page }) => {
  const [ws] = await openAreas(page);
  ws?.send(JSON.stringify({ channel: "alerts", data: ALERT }));
  await side(page).getByRole("button", { name: "收起告警" }).click();
  await expect(side(page)).toBeHidden();
  const capsule = page.getByRole("button", { name: "展开告警（1 条）" });
  await expect(capsule).toBeVisible();
  await expect(page).toHaveScreenshot("alert-capsule.png");

  await page.getByRole("button", { name: "查看 cam-02 详情" }).click();
  await expect(side(page).getByRole("heading", { name: "cam-02" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(capsule).toBeVisible();

  await capsule.click();
  await expect(side(page).getByRole("button", { name: /HYD-NET-0001/ })).toBeVisible();
});
