import { expect, test } from "@playwright/test";
import { camera, expectNoOverflow, freezeClock, open, presetTheme } from "./helpers";

const base = (n: number) => ({
  schema_version: "1.2.0",
  event_id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  ts: `2026-10-27T06:29:${String(n).padStart(2, "0")}Z`,
});

const ALERTS = [
  {
    ...base(10),
    rule_id: "HYD-NET-0001", rule_version: "3", mode: "enforce", category: "auth_bruteforce",
    severity: "high", src_ip: "172.30.0.100", dst_ip: "172.30.0.12", device_id: "cam-02",
    technique: "T1110", evidence_ref: "suricata:flow/1", source: "rule", confidence: 1,
    summary: "HYD-NET-0001 RTSP authentication brute force",
  },
  {
    ...base(20),
    rule_id: "HYD-NET-BEH", rule_version: "1", mode: "enforce", category: "behavior_anomaly",
    severity: "medium", src_ip: "172.30.0.100", dst_ip: "172.30.0.12", device_id: "cam-02",
    technique: "T1110", evidence_ref: "zeek:conn/1", source: "model", confidence: 0.82,
    summary: "陌生访问方，失败率为基线 6 倍",
  },
  {
    ...base(30), camera_id: "cam-01", track_id: 3, behavior: "fall", confidence_avg: 0.9,
    duration_s: 2, ts_start: base(30).ts, ts_end: base(30).ts,
  },
]; // prettier-ignore

const INCIDENT = {
  id: "inc-1", rule_id: "HYD-X-0001", rule_version: "1.0.0", mode: "enforce",
  title: "摄像头疑似被入侵且画面遭篡改", severity: "critical", device_ids: ["cam-02"],
  source_ip: "172.30.0.100", techniques: ["T1110", "T0832"], tactics: ["Credential Access", "Impact"],
  evidence_refs: [], hit_path: [], requires_confirmation: false, status: "open",
  created_at: "2026-10-27T06:29:40Z",
}; // prettier-ignore

const EXECUTION = {
  id: "exe-1", playbook_id: "isolate-attacker", playbook_version: "1.0.0", incident_id: "inc-1",
  device_ids: ["cam-02"], target: "172.30.0.100", state: "contained", reason: null, ttl_s: 150,
  expires_at: "2026-10-27T06:32:10Z", verify_result: { passed: true, reason: "封禁规则已生效，已拦截 8 个数据包" },
}; // prettier-ignore

for (const theme of ["light", "dark"] as const) {
  test(`告警列表：关联事件置顶与处置状态，规则 / 模型来源（${theme}，D-077）`, async ({ page }) => {
    await presetTheme(page, theme, true);
    await freezeClock(page);
    const sockets = await open(page, [camera("normal", "cam-01"), camera("contained", "cam-02")]);
    for (const data of ALERTS) sockets[0]?.send(JSON.stringify({ channel: "alerts", data }));
    sockets[0]?.send(JSON.stringify({ channel: "incidents", data: INCIDENT }));
    sockets[0]?.send(JSON.stringify({ channel: "executions", data: EXECUTION }));

    const panel = page.getByRole("complementary", { name: "告警" });
    await expect(panel.getByText("已处置")).toBeVisible();
    await expectNoOverflow(page);
    await expect(panel).toHaveScreenshot(`alert-list-${theme}.png`);
  });
}

test("单击告警选中对应设备并展开详情（V-I3）", async ({ page }) => {
  await presetTheme(page, "light", true);
  await freezeClock(page);
  const sockets = await open(page, [camera("normal", "cam-01"), camera("cyber_alert", "cam-02")]);
  sockets[0]?.send(JSON.stringify({ channel: "alerts", data: ALERTS[0] }));

  await page.getByRole("button", { name: /HYD-NET-0001 RTSP/ }).click();
  await expect(page.getByRole("heading", { name: "cam-02" })).toBeVisible();
});

for (const theme of ["light", "dark"] as const) {
  test(`处置栏：已处置的拦截证据、剩余时间与解封按钮（${theme}，TK-052）`, async ({ page }) => {
    await presetTheme(page, theme, true);
    await freezeClock(page);
    await page.route("/api/auth/session", (route) =>
      route.fulfill({ json: { username: "operator", role: "operator", expires_at: "2026-10-27T14:30:00Z" } }),
    );
    const sockets = await open(page, [camera("normal", "cam-01"), camera("contained", "cam-02")]);
    // 到期时刻取页面时钟当前值加 130 s：加载场景时模拟时钟推进的量不固定，剩余时间须确定才能截图
    const now = await page.evaluate(() => Date.now());
    const expires_at = new Date(now + 130_000).toISOString();
    sockets[0]?.send(JSON.stringify({ channel: "executions", data: { ...EXECUTION, expires_at } }));
    sockets[0]?.send(JSON.stringify({ channel: "alerts", data: ALERTS[0] }));
    await page.getByRole("button", { name: /HYD-NET-0001 RTSP/ }).click();

    const bar = page.getByRole("region", { name: "处置" });
    await expect(bar.getByRole("button", { name: "立即解封" })).toBeVisible();
    await expect(bar).toContainText("剩余 2:10");
    await expectNoOverflow(page);
    await expect(bar).toHaveScreenshot(`action-bar-${theme}.png`);
  });
}
