import { describe, expect, it } from "vitest";
import { areaAlerts, currentArea, sortAreas } from "../../src/scene/areas";
import type { Device } from "../../src/store/live";

const device = (id: string, state: Device["state"], area_id: string | null) =>
  ({ id, state, camera: { area_id } }) as unknown as Device;
const area = (id: string) => ({ id, name: id, width_m: 10, depth_m: 10, items: [], updated_at: "2026-11-09T00:00:00Z" });

describe("区域告警计数（设计 150 §3）", () => {
  it("按区域数告警中的设备，物理与网络分开；both 两边各计一次", () => {
    const alerts = areaAlerts([
      device("cam-01", "physical_alert", "area-01"),
      device("cam-02", "both", "area-01"),
      device("cam-03", "cyber_alert", "area-02"),
      device("cam-04", "pending_action", "area-02"),
      device("cam-05", "notify_only", "area-02"),
    ]);
    expect(alerts.get("area-01")).toEqual({ physical: 2, cyber: 1 });
    expect(alerts.get("area-02")).toEqual({ physical: 0, cyber: 3 });
  });

  it("正常、离线、未标定、已处置不计；未放入区域的设备不计", () => {
    const alerts = areaAlerts([
      device("cam-01", "normal", "area-01"),
      device("cam-02", "offline", "area-01"),
      device("cam-03", "uncalibrated", "area-01"),
      device("cam-04", "contained", "area-01"),
      device("cam-05", "cyber_alert", null),
    ]);
    expect(alerts.size).toBe(0);
  });
});

describe("区域顺序与当前区域", () => {
  const areas = [area("area-01"), area("area-02"), area("area-03")];
  const alerts = areaAlerts([device("cam-03", "cyber_alert", "area-03")]);

  it("有告警的区域置顶，其余保持原顺序", () => {
    expect(sortAreas(areas, alerts).map((a) => a.id)).toEqual(["area-03", "area-01", "area-02"]);
  });

  it("所选区域存在时为它；未选或已删除时为列表第一个；没有区域时为 null", () => {
    expect(currentArea(areas, alerts, "area-02")?.id).toBe("area-02");
    expect(currentArea(areas, alerts, null)?.id).toBe("area-03");
    expect(currentArea(areas, new Map(), "area-09")?.id).toBe("area-01");
    expect(currentArea([], alerts, null)).toBeNull();
  });
});
