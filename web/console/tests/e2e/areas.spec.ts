import { expect, type Page, test } from "@playwright/test";
import { AREA, camera, expectApart, expectNoOverflow, freezeClock, mockKpis, mockLlmStatus, mockSocket, presetMotion, SITE, sceneSettled, UNAUTHORIZED } from "./helpers";

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

async function openAreas(page: Page, areas = [HALL, ROOM], devices = [CAM01, CAM02]) {
  await page.route("/api/site", (route) => route.fulfill({ json: { ...SITE, areas, devices } }));
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
  await expectApart([page.getByRole("list", { name: "关键指标" }), switcher(page), side(page)]);
  await expect(page).toHaveScreenshot("area-switched.png");
});

test("1366 宽下区域名称很长、其他区域两类告警都是两位数：区域切换不碰到告警卡", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  const hall = { ...HALL, name: "一号楼地下一层设备间与配电室东侧走廊" };
  const both = Array.from({ length: 12 }, (_, i) => inArea({ ...camera("both", `cam-${10 + i}`) }, ROOM.id));
  await openAreas(page, [hall, ROOM], [CAM01, ...both]);
  await switcher(page).click();
  await page.getByRole("menuitemradio").filter({ hasText: hall.name }).click();
  const others = switcher(page).getByRole("group", { name: "其他区域" });
  await expect(others.getByRole("img", { name: "物理告警 12 台" })).toBeVisible();
  await expect(others.getByRole("img", { name: "网络攻击 12 台" })).toBeVisible();
  await expectApart([page.getByRole("list", { name: "关键指标" }), switcher(page), side(page)]);
});

test("退出后换账户登录：从列表第一个区域开始，不沿用上一账户选的区域", async ({ page }) => {
  await openAreas(page);
  await switcher(page).click();
  await page.getByRole("menuitemradio", { name: /一号楼大厅/ }).click();
  await expect(switcher(page)).toHaveAccessibleName("区域：一号楼大厅");

  await page.route("/api/site", (route) => route.fulfill({ status: 401, json: UNAUTHORIZED }));
  await page.route("/api/auth/logout", (route) => route.fulfill({ status: 204 }));
  await page.getByRole("button", { name: "退出登录" }).click();
  await expect(page.getByRole("heading", { name: "欢迎回来" })).toBeVisible();

  await page.route("/api/site", (route) => route.fulfill({ json: { ...SITE, areas: [HALL, ROOM], devices: [CAM01, CAM02] } }));
  await page.route("/api/auth/login", (route) => route.fulfill({ json: { role: "viewer", expires_at: "2026-10-27T08:00:00Z" } }));
  await page.getByLabel("用户名").fill("viewer");
  await page.getByLabel("密码", { exact: true }).fill("secret");
  await page.getByRole("button", { name: "登录" }).click();
  await expect(switcher(page)).toHaveAccessibleName("区域：二号楼机房");
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
