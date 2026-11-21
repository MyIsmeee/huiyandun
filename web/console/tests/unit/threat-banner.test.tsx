import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ThreatBanner } from "../../src/panels/ThreatBanner/ThreatBanner";
import { durationText, threatOf } from "../../src/panels/ThreatBanner/threat";
import type { Alert, Device, Execution, Incident, Site } from "../../src/store/live";
import { useLive } from "../../src/store/live";

const device = (id: string, state: Device["state"] = "normal") => ({ id, name: `摄像头 ${id}`, state }) as unknown as Device;
const alert = (id: string, ts: string, device_id = "cam-11") =>
  ({ event_id: id, ts, src_ip: "172.30.0.100", device_id, summary: "RTSP 弱口令爆破" }) as unknown as Alert;
const incident = (patch: Partial<Incident> = {}) =>
  ({
    id: "inc-1",
    rule_id: "HYD-NET-0101",
    title: "摄像头 RTSP 口令爆破",
    severity: "high",
    device_ids: ["cam-11"],
    source_ip: "172.30.0.100",
    hit_path: ["a-1"],
    status: "open",
    created_at: "2026-11-18T10:00:05Z",
    ...patch,
  }) as unknown as Incident;
const execution = (state: Execution["state"], patch: Partial<Execution> = {}) =>
  ({ id: "exec-1", incident_id: "inc-1", device_ids: ["cam-11"], target: "172.30.0.100", state, ttl_s: 1800, expires_at: null, ...patch }) as Execution;

const SITE = [device("cam-01"), device("cam-11")];
const live = (patch: Partial<Parameters<typeof threatOf>[0]> = {}) => ({
  devices: {},
  alerts: [alert("a-1", "2026-11-18T10:00:00Z")],
  incidents: [incident()],
  executions: {},
  aiSeq: {},
  aiDone: {},
  ...patch,
});

describe("threatOf：攻防态势", () => {
  it("没有设备处于网络攻击或处置状态时为空；物理告警不算", () => {
    expect(threatOf(live({ devices: { "cam-11": device("cam-11", "physical_alert") } }), SITE)).toBeNull();
  });

  it("网络攻击中：给出被攻击的设备、攻击手法、攻击源与发现时刻", () => {
    const threat = threatOf(live({ devices: { "cam-11": device("cam-11", "cyber_alert") } }), SITE);

    expect(threat).toMatchObject({ phase: "attack", title: "摄像头 RTSP 口令爆破", source: "172.30.0.100" });
    expect(threat?.devices.map((d) => d.id)).toEqual(["cam-11"]);
    expect(threat?.startedAt).toBe(Date.parse("2026-11-18T10:00:00Z"));
  });

  it("执行在等待确认时为待人工确认；处置中、只通知各为对应阶段", () => {
    const attacked = { "cam-11": device("cam-11", "cyber_alert") };
    expect(threatOf(live({ devices: attacked, executions: { "exec-1": execution("pending") } }), SITE)?.phase).toBe("confirm");
    expect(threatOf(live({ devices: { "cam-11": device("cam-11", "pending_action") } }), SITE)?.phase).toBe("defending");
    expect(threatOf(live({ devices: { "cam-11": device("cam-11", "notify_only") } }), SITE)?.phase).toBe("notified");
  });

  it("已阻断：用时取发现攻击到处置生效（到期时刻减封禁时长）", () => {
    const exe = execution("contained", { expires_at: "2026-11-18T10:30:12Z" });
    const threat = threatOf(live({ devices: { "cam-11": device("cam-11", "contained") }, executions: { [exe.id]: exe } }), SITE);

    expect(threat?.phase).toBe("contained");
    expect((threat?.containedAt ?? 0) - (threat?.startedAt ?? 0)).toBe(12_000);
  });

  it("多台设备处于不同阶段时显示最紧急的：一台已阻断、一台正被攻击 → 攻击中，被攻击的排在前面", () => {
    const threat = threatOf(
      live({ devices: { "cam-01": device("cam-01", "cyber_alert"), "cam-11": device("cam-11", "contained") }, incidents: [] }),
      SITE,
    );

    expect(threat?.phase).toBe("attack");
    expect(threat?.devices.map((d) => d.id)).toEqual(["cam-01", "cam-11"]);
  });

  it("AI 研判进度取推送的步数，结束帧到达后为完成", () => {
    const attacked = { "cam-11": device("cam-11", "cyber_alert") };
    expect(threatOf(live({ devices: attacked, aiSeq: { "inc-1": 3 } }), SITE)?.ai).toEqual({ state: "running", steps: 3 });
    expect(threatOf(live({ devices: attacked, aiSeq: { "inc-1": 5 }, aiDone: { "inc-1": true } }), SITE)?.ai.state).toBe("done");
  });

  it("用时写法", () => {
    expect(durationText(12_400)).toBe("12 秒");
    expect(durationText(65_000)).toBe("1 分 05 秒");
  });
});

describe("ThreatBanner", () => {
  const site = { devices: SITE } as unknown as Site;
  beforeEach(() => useLive.setState(useLive.getInitialState()));
  afterEach(cleanup);

  it("平时不显示", () => {
    const { container } = render(<ThreatBanner site={site} />);
    expect(container.innerHTML).toBe("");
  });

  it("被攻击时红色横幅与屏幕边缘红光；阻断后变绿、写明已封禁，红光撤下", () => {
    useLive.setState({ ...live(), devices: { "cam-11": device("cam-11", "cyber_alert") } });
    const { container } = render(<ThreatBanner site={site} />);

    expect(screen.getByRole("alert").textContent).toContain("摄像头 cam-11（cam-11） 正在遭受网络攻击");
    expect(screen.getByRole("alert").textContent).toContain("攻击源 172.30.0.100");
    expect(container.querySelector("[data-attack-glow]")).not.toBeNull();

    const exe = execution("contained", { expires_at: "2026-11-18T10:30:12Z" });
    act(() => useLive.setState({ devices: { "cam-11": device("cam-11", "contained") }, executions: { [exe.id]: exe } }));

    expect(screen.getByRole("status").textContent).toContain("AI 防护已阻断攻击 · 攻击源 172.30.0.100 已封禁");
    expect(screen.getByRole("status").textContent).toContain("从发现到阻断用时 12 秒");
    expect(container.querySelector("[data-attack-glow]")).toBeNull();
    expect(container.querySelector("[data-contained-flash]")).not.toBeNull();
    expect(container.querySelectorAll('[data-step="done"]')).toHaveLength(4);
  });

  it("旁路模式只通知：不写\"已阻断\"（V-T1）", () => {
    useLive.setState({ ...live(), devices: { "cam-11": device("cam-11", "notify_only") } });
    render(<ThreatBanner site={site} />);

    expect(screen.getByRole("alert").textContent).toContain("已通知，待联动处置");
    expect(screen.getByRole("alert").textContent).not.toContain("已阻断");
  });
});
