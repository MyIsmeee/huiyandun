import { expect, type Page, test } from "@playwright/test";
import { camera, expectApart, expectNoOverflow, freezeClock, open, presetMotion, withoutWebGL2 } from "./helpers";

// TK-156 验收（设计 150 §3、§11）：态势页浮动卡片的选中、返回、Esc；1366×768 与 1920×1080 下互不遮挡、不溢出（V-P3）
test.beforeEach(async ({ page }) => {
  await presetMotion(page, true);
  await freezeClock(page);
});

const ALERT = {
  schema_version: "1.2.0", event_id: "00000000-0000-4000-8000-000000000010", ts: "2026-10-27T06:29:10Z",
  rule_id: "HYD-NET-0001", rule_version: "3", mode: "enforce", category: "auth_bruteforce",
  severity: "high", src_ip: "172.30.0.100", dst_ip: "172.30.0.12", device_id: "cam-02",
  technique: "T1110", evidence_ref: "suricata:flow/1", source: "rule", confidence: 1,
  summary: "HYD-NET-0001 RTSP authentication brute force",
}; // prettier-ignore
const INCIDENT = {
  id: "inc-1", rule_id: "HYD-X-0001", rule_version: "1.0.0", mode: "enforce",
  title: "摄像头疑似被入侵且画面遭篡改", severity: "critical", device_ids: ["cam-02"],
  source_ip: "172.30.0.100", techniques: ["T1110"], tactics: [], evidence_refs: [],
  hit_path: [ALERT.event_id], requires_confirmation: false, status: "open", created_at: "2026-10-27T06:29:40Z",
}; // prettier-ignore

const CAM02 = { ...camera("cyber_alert", "cam-02"), ip: "172.30.0.12" };
const side = (page: Page) => page.getByRole("complementary", { name: "告警与详情" });
const progress = (page: Page) => page.getByRole("region", { name: "处置进度" });

async function openIncident(page: Page, state: "ready" | "2d" = "ready") {
  const [ws] = await open(page, [camera("normal", "cam-01"), CAM02], state);
  ws?.send(JSON.stringify({ channel: "alerts", data: ALERT }));
  ws?.send(JSON.stringify({ channel: "incidents", data: INCIDENT }));
  return ws;
}

for (const [width, height] of [
  [1366, 768],
  [1920, 1080],
] as const) {
  test(`选中告警：详情卡与底部处置进度条，卡片互不遮挡（${width}×${height}）`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await openIncident(page);
    // 进行中的事件未选中时同样显示
    await expect(progress(page)).toContainText("摄像头疑似被入侵且画面遭篡改");

    await side(page).getByRole("button", { name: /摄像头疑似被入侵/ }).click();
    await expect(side(page).getByRole("heading", { name: "cam-02" })).toBeVisible();
    // 态势页由进度条显示五个节点，详情不再重复竖向时间线（产品负责人 2026-11-09 选定）
    await expect(side(page).getByRole("heading", { name: "处置时间线" })).toHaveCount(0);
    await expectApart([
      page.getByRole("list", { name: "关键指标" }),
      page.getByRole("button", { name: /^区域：/ }),
      side(page),
      page.getByRole("toolbar", { name: "视角" }),
      progress(page),
    ]);
    await expectNoOverflow(page);
    await expect(page).toHaveScreenshot(`overview-selected-${width}.png`);
  });
}

test("无 WebGL2 且事件进行中、连接断开：断线提示、2D 降级说明与进度条互不遮挡（1366×768，C-FE-08）", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await withoutWebGL2(page);
  const ws = await openIncident(page, "2d");
  await expect(progress(page)).toBeVisible();
  ws?.close();
  const degraded = page.getByText("2D 视图 · 不支持 WebGL2");
  await expectApart([
    page.getByRole("status", { name: "断线提示" }),
    degraded,
    page.getByRole("toolbar", { name: "视角" }),
    progress(page),
    side(page),
  ]);
  await expectNoOverflow(page);
});

test("卡片外的区域不拦截指针：区域切换下方的点落在场景上，指标卡本身不透过（V-L3）", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await openIncident(page);
  const inScene = (x: number, y: number) =>
    page.evaluate(([px, py]) => document.elementFromPoint(px, py)?.closest('[aria-label="场景"]') != null, [x, y] as const);
  const switcher = await page.getByRole("button", { name: /^区域：/ }).boundingBox();
  const kpi = await page.getByRole("list", { name: "关键指标" }).getByRole("listitem").first().boundingBox();
  if (!switcher || !kpi) throw new Error("卡片未显示");
  // 区域切换比指标卡矮，其下方仍在指标卡所在的一行内
  expect(await inScene(switcher.x + switcher.width / 2, switcher.y + switcher.height + 8)).toBe(true);
  expect(await inScene(kpi.x + kpi.width / 2, kpi.y + kpi.height / 2)).toBe(false);
});

test("返回与 Esc：详情卡回到告警列表；事件结束后进度条消失", async ({ page }) => {
  const ws = await openIncident(page);
  await side(page).getByRole("button", { name: /HYD-NET-0001/ }).click();
  await side(page).getByRole("button", { name: "返回告警" }).click();
  await expect(side(page).getByRole("heading", { name: "告警" })).toBeVisible();

  await side(page).getByRole("button", { name: /HYD-NET-0001/ }).click();
  await page.keyboard.press("Escape");
  await expect(side(page).getByRole("heading", { name: "cam-02" })).toHaveCount(0);
  await expect(progress(page)).toBeVisible();

  ws?.send(JSON.stringify({ channel: "devices", data: { ...CAM02, state: "normal" } }));
  await expect(progress(page)).toHaveCount(0);
});

test("监控墙页的详情保留竖向处置时间线", async ({ page }) => {
  await openIncident(page);
  await page.getByRole("navigation", { name: "导航" }).getByRole("button", { name: "监控墙" }).click();
  await page.getByRole("complementary", { name: "检查栏" }).getByRole("button", { name: /摄像头疑似被入侵/ }).click();
  await expect(page.getByRole("heading", { name: "处置时间线" })).toBeVisible();
});
