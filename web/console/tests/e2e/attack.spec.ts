import { expect, test } from "@playwright/test";
import { camera, expectNoOverflow, freezeClock, open, presetTheme, sceneSettled } from "./helpers";

const ALERT = {
  schema_version: "1.2.0", event_id: "00000000-0000-4000-8000-000000000001", ts: "2026-10-27T06:29:50Z",
  rule_id: "HYD-NET-0001", rule_version: "3", mode: "enforce", category: "auth_bruteforce", severity: "high",
  src_ip: "172.30.0.100", dst_ip: "172.30.0.11", device_id: "cam-01", technique: "T1110",
  evidence_ref: "suricata:flow/1", source: "rule", confidence: 1,
  summary: "HYD-NET-0001 RTSP authentication brute force",
}; // prettier-ignore

for (const theme of ["light", "dark"] as const) {
  test(`网络攻击：外部攻击源标出 IP，红色虚线连到设备（${theme}，D-076）`, async ({ page }) => {
    await presetTheme(page, theme, true);
    await freezeClock(page);
    const sockets = await open(page, [camera("normal")]);
    sockets[0]?.send(JSON.stringify({ channel: "alerts", data: ALERT }));
    sockets[0]?.send(JSON.stringify({ channel: "devices", data: camera("cyber_alert") }));

    await expect(page.locator("[data-attacker=cam-01]")).toContainText("外部攻击源 172.30.0.100");
    await sceneSettled(page); // 场景按需重绘：时钟暂停时推进，设备与视场转为网络攻击色
    await expectNoOverflow(page);
    await expect(page.getByRole("region", { name: "场景" })).toHaveScreenshot(`attack-line-${theme}.png`);
  });
}

test("已处置：虚线断开并淡出；降低动效时瞬时消失（04 §5.2、V-A4）", async ({ page }) => {
  await presetTheme(page, "light", true);
  await freezeClock(page);
  const sockets = await open(page, [camera("normal")]);
  sockets[0]?.send(JSON.stringify({ channel: "alerts", data: ALERT }));
  sockets[0]?.send(JSON.stringify({ channel: "devices", data: camera("cyber_alert") }));
  await expect(page.locator("[data-attacker=cam-01]")).toBeVisible();

  sockets[0]?.send(JSON.stringify({ channel: "devices", data: camera("contained") }));

  await expect(page.locator("[data-attack-broken=cam-01] line")).toHaveCount(2);
  await expect(page.locator("[data-attack-broken=cam-01]")).toHaveCSS("opacity", "0");
  await expect(page.locator("[data-attacker=cam-01]")).toHaveCSS("opacity", "0");
});

test("没有网络告警的设备不画连线", async ({ page }) => {
  await presetTheme(page, "light", true);
  await freezeClock(page);
  const sockets = await open(page, [camera("normal")]);
  sockets[0]?.send(JSON.stringify({ channel: "devices", data: camera("physical_alert") }));
  await expect(page.locator("[data-attacker]")).toHaveCount(0);
});
