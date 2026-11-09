import { expect, type Locator, type Page, test } from "@playwright/test";
import { camera, expectNoOverflow, freezeClock, open, presetMotion } from "./helpers";

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

async function openIncident(page: Page) {
  const [ws] = await open(page, [camera("normal", "cam-01"), CAM02]);
  ws?.send(JSON.stringify({ channel: "alerts", data: ALERT }));
  ws?.send(JSON.stringify({ channel: "incidents", data: INCIDENT }));
  return ws;
}

/** 浮动卡片两两不重叠 */
async function expectApart(cards: Locator[]) {
  const boxes = await Promise.all(cards.map((c) => c.boundingBox()));
  for (const [i, a] of boxes.entries())
    for (const b of boxes.slice(i + 1)) {
      if (!a || !b) throw new Error("卡片未显示");
      expect(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y).toBe(true);
    }
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
