import { expect, test, type WebSocketRoute } from "@playwright/test";
import { camera, open, presetMotion } from "./helpers";

const nvr = { id: "nvr-01", name: "录像机", type: "nvr", ip: "172.30.0.20", mode: "bypass", state: "normal", alert_severity: null, camera: null };

let seq = 0;
const alert = (src: string, device: string, dst: string, patch: object = {}) => ({
  schema_version: "1.2.0", event_id: `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`, ts: new Date().toISOString(),
  rule_id: "HYD-NET-0001", rule_version: "3", mode: "enforce", category: "auth_bruteforce", severity: "high",
  src_ip: src, dst_ip: dst, device_id: device, technique: "T1110", evidence_ref: "suricata:flow/1", source: "rule", confidence: 1,
  summary: "HYD-NET-0001 RTSP authentication brute force", ...patch,
}); // prettier-ignore

function push(socket: WebSocketRoute | undefined, channel: string, data: object) {
  socket?.send(JSON.stringify({ channel, data }));
}

test("关系图：以摄像头为中心，攻击源、关联事件、处置与被同一攻击源攻击的设备连在一起", async ({ page }) => {
  await presetMotion(page, true);
  const sockets = await open(page, [camera("normal", "cam-01"), camera("normal", "cam-02"), nvr]);
  const ws = sockets[0];
  const first = alert("172.30.0.100", "cam-01", "172.30.0.11");
  push(ws, "alerts", first);
  push(ws, "alerts", alert("172.30.0.100", "cam-01", "172.30.0.11"));
  push(ws, "alerts", alert("172.30.0.100", "nvr-01", "172.30.0.20"));
  push(ws, "alerts", alert("172.30.0.101", "cam-01", "172.30.0.11", { rule_id: "HYD-NET-0002", category: "stream_hijack", technique: "T1557", severity: "critical" }));
  push(ws, "alerts", alert("10.8.8.8", "cam-02", "172.30.0.12")); // 与 cam-01 无关
  push(ws, "incidents", {
    schema_version: "1.0.0", event_id: "00000000-0000-4000-8000-0000000000aa", ts: new Date().toISOString(),
    id: "inc-1", rule_id: "HYD-COR-0001", rule_version: "1", mode: "enforce", title: "摄像头口令爆破", severity: "high",
    device_ids: ["cam-01"], source_ip: "172.30.0.100", techniques: ["T1110"], tactics: ["credential-access"], evidence_refs: [],
    hit_path: [first.event_id], requires_confirmation: false, status: "containing", created_at: new Date().toISOString(),
  }); // prettier-ignore
  push(ws, "executions", {
    schema_version: "1.0.0", event_id: "00000000-0000-4000-8000-0000000000bb", ts: new Date().toISOString(),
    id: "exec-1", playbook_id: "block-ip", playbook_version: "1", incident_id: "inc-1", device_ids: ["cam-01"], target: "172.30.0.100",
    state: "contained", reason: null, ttl_s: 1800, expires_at: new Date(Date.now() + 1_800_000).toISOString(), verify_result: null,
  }); // prettier-ignore
  push(ws, "alerts", {
    schema_version: "1.2.0", event_id: "00000000-0000-4000-8000-0000000000cc", ts: new Date().toISOString(), camera_id: "cam-01",
    track_id: 3, behavior: "climb", level: "confirmed", confidence_avg: 0.9, duration_s: 3, ts_start: new Date().toISOString(), ts_end: new Date().toISOString(),
  }); // prettier-ignore

  await page.getByRole("button", { name: "关系图" }).click();
  const dialog = page.getByRole("dialog", { name: "关系图" });
  await expect(dialog).toBeVisible();
  // 图例按类型计数：两台摄像头之一不在 cam-01 的子图里
  await expect(dialog.getByRole("button", { name: /^攻击源\s*2$/ })).toBeVisible();
  await expect(dialog.getByRole("button", { name: /^关联事件\s*1$/ })).toBeVisible();
  await expect(dialog.getByRole("button", { name: /^处置\s*1$/ })).toBeVisible();
  const summary = dialog.getByTestId("relation-narrative");
  await expect(summary).toContainText("遭到 2 个攻击源的 3 次网络攻击");
  await expect(summary).toContainText("已封禁 1 个攻击源");
  await expect(summary).toContainText("攀爬越界 1 次");
  await expect(summary).toContainText("同一攻击源还攻击了 nvr-01");
  await expect(dialog.getByRole("button", { name: /nvr-01/ })).toBeVisible();
  await expect(dialog.locator("canvas").first()).toBeVisible();
  await page.waitForTimeout(1500); // 布局动画
  if (process.env.RELATION_SHOT) await page.screenshot({ path: process.env.RELATION_SHOT });

  // 关联设备可切为中心
  await dialog.getByRole("button", { name: /nvr-01/ }).click();
  await expect(summary).toContainText("录像机 遭到 1 个攻击源的 1 次网络攻击");
  await expect(summary).toContainText("同一攻击源还攻击了 cam-01");
  if (process.env.RELATION_SHOT) await page.waitForTimeout(1500);
  if (process.env.RELATION_SHOT) await page.screenshot({ path: process.env.RELATION_SHOT.replace(".png", "-nvr.png") });

  // 实时：新的攻击到达即出现在图上
  push(ws, "alerts", alert("172.30.0.200", "nvr-01", "172.30.0.20"));
  await expect(summary).toContainText("录像机 遭到 2 个攻击源的 2 次网络攻击");
});
