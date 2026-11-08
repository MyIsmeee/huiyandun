import { expect, type Page, test } from "@playwright/test";
import { camera, expectNoOverflow, mockKpis, mockLlmStatus, mockSocket, presetView, SITE } from "./helpers";

/** 以给定摄像头打开监控墙（D-115）；实时画面信令返回不可用，瓦片显示原因而不是一直连接中 */
async function openWall(page: Page, ids: string[], layout = "auto") {
  await presetView(page, "wall", layout);
  const devices = ids.map((id, i) => ({ ...camera(i === 1 ? "physical_alert" : "normal", id), name: `画面 ${i + 1}` }));
  await page.route("/api/site", (route) => route.fulfill({ json: { ...SITE, devices } }));
  await page.route(/\/api\/devices\/.+\/webrtc/, (route) =>
    route.fulfill({ status: 503, json: { code: "unavailable", message: "视频服务不可用", request_id: "r" } }),
  );
  await mockLlmStatus(page);
  await mockKpis(page);
  const sockets = await mockSocket(page);
  await page.goto("/");
  await expect(page.getByRole("list", { name: "监控墙" })).toBeVisible();
  return { devices, sockets };
}

const wall = (page: Page) => page.getByRole("list", { name: "监控墙" });
const tile = (page: Page, id: string) => wall(page).getByRole("button", { name: new RegExp(`^${id} `) });

test("默认视图为监控墙：自动宫格按路数排列，告警瓦片显示状态（V-W1、V-W2）", async ({ page }) => {
  await openWall(page, ["cam-01", "cam-02"]);
  await expect(page.getByRole("radio", { name: "监控墙" })).toHaveAttribute("aria-checked", "true");
  await expect(wall(page).getByRole("listitem")).toHaveCount(2);
  await expect(tile(page, "cam-02").getByRole("status")).toHaveText("物理告警");
  await expect(wall(page).getByText("视频服务不可用")).toHaveCount(2);
  await expectNoOverflow(page);
  await expect(page).toHaveScreenshot("wall-auto.png");
});

test("固定 4 宫格不足一页显示空位；1+5 以选中的摄像头为大格", async ({ page }) => {
  await openWall(page, ["cam-01", "cam-02"], "4");
  await expect(wall(page).getByRole("listitem", { name: "空位" })).toHaveCount(2);

  await page.getByRole("radio", { name: "1+5 宫格" }).click();
  await tile(page, "cam-02").click();
  await expect(wall(page).getByRole("listitem").first()).toContainText("cam-02");
  await expect(page).toHaveScreenshot("wall-featured.png");
});

test("单击瓦片在检查栏显示详情，Esc 返回告警；双击放大，Esc 还原（V-W4）", async ({ page }) => {
  await openWall(page, ["cam-01", "cam-02"]);
  await tile(page, "cam-01").click();
  const detail = page.getByRole("region", { name: "详情" });
  await expect(detail.getByRole("heading", { level: 2 })).toHaveText("cam-01");
  await expect(tile(page, "cam-01")).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await expect(detail).toHaveCount(0);

  await tile(page, "cam-02").dblclick();
  await page.keyboard.press("Escape"); // 双击同时选中：第一次 Esc 返回告警
  await expect(wall(page).getByRole("listitem")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(wall(page).getByRole("listitem")).toHaveCount(2);
});

test("超出容量分页，前后翻页（V-W1；选中自动翻页随摄像头栏验证）", async ({ page }) => {
  await openWall(page, ["cam-01", "cam-02", "cam-03", "cam-04", "cam-05"], "4");
  await expect(page.getByText("1 / 2")).toBeVisible();
  await page.getByRole("button", { name: "下一页" }).click();
  await expect(wall(page).getByRole("listitem").first()).toContainText("cam-05");
  await page.getByRole("button", { name: "上一页" }).click();
  await expect(page.getByText("1 / 2")).toBeVisible();
});

test("放大的摄像头被删除：还原宫格，分页恢复（V-W4）", async ({ page }) => {
  const { devices, sockets } = await openWall(page, ["cam-01", "cam-02", "cam-03", "cam-04", "cam-05", "cam-06"], "4");
  await tile(page, "cam-01").dblclick();
  await expect(wall(page).getByRole("listitem")).toHaveCount(1);
  await expect(page.getByText("1 / 2")).toHaveCount(0);

  sockets[0]?.send(JSON.stringify({ channel: "site", data: { ...SITE, devices: devices.slice(1) } }));
  await expect(wall(page).getByRole("listitem")).toHaveCount(4);
  await expect(page.getByText("1 / 2")).toBeVisible();
});

test("切换到空间态势后显示 3D 场景，宫格控件隐藏，所选视图记在本地", async ({ page }) => {
  await openWall(page, ["cam-01"]);
  await page.getByRole("radio", { name: "空间态势" }).click();
  await expect(page.getByRole("region", { name: "场景" })).toBeVisible();
  await expect(page.getByRole("group", { name: "宫格" })).toHaveCount(0);
  // 预置脚本每次导航都会重写，刷新验证不了：直接核对写入本地的视图（V-L1 位置记忆）
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("hyd-wall") ?? "{}").state?.view)).toBe("space");
});
