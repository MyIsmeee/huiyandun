import { describe, expect, it } from "vitest";
import { monotonePath, niceMax } from "../../src/panels/BigScreen/charts";
import {
  areaDistribution,
  deviceRows,
  eventRows,
  GAP_M,
  hourlyTrend,
  layoutAreas,
  MAX_AREAS,
  patrolList,
  stamp,
  targetCounts,
} from "../../src/panels/BigScreen/data";
import type { Alert, Device, Target } from "../../src/store/live";

const device = (id: string, state: Device["state"], area_id: string | null, name = id) =>
  ({ id, name, ip: "10.0.0.1", state, type: "camera", camera: area_id === undefined ? null : { area_id } }) as unknown as Device;
const area = (id: string, width_m = 10, depth_m = 10) => ({ id, name: `区域${id}`, width_m, depth_m, items: [], updated_at: "2026-11-09T00:00:00Z" });
const cyber = (ts: string, device_id: string | null, severity = "high") =>
  ({ event_id: `n-${ts}-${device_id}`, ts, device_id, severity, source: "rule", category: "auth_bruteforce", rule_id: "r", summary: "s", confidence: 1 }) as unknown as Alert;
const fall = (ts: string, camera_id: string, level = "confirmed") =>
  ({ event_id: `b-${ts}-${camera_id}`, ts, camera_id, track_id: 1, behavior: "fall", level, confidence_avg: 0.9 }) as unknown as Alert;

describe("告警趋势（原历史功率）", () => {
  it("按小时分桶、网络与物理分开，最后一格为当前小时，窗口外不计", () => {
    const now = Date.parse("2026-11-18T10:30:00Z");
    const t = hourlyTrend(
      [cyber("2026-11-18T10:05:00Z", "cam-01"), fall("2026-11-18T10:20:00Z", "cam-01"), fall("2026-11-18T08:59:00Z", "cam-02"), cyber("2026-11-17T09:00:00Z", "cam-01")],
      now,
    );
    expect(t.labels).toHaveLength(24);
    expect(t.cyber.at(-1)).toBe(1);
    expect(t.physical.at(-1)).toBe(1);
    expect(t.physical.at(-3)).toBe(1);
    expect(t.cyber.reduce((a, b) => a + b)).toBe(1);
  });
});

describe("区域告警分布（原故障对比）", () => {
  const devices = [device("cam-01", "normal", "a1"), device("cam-02", "normal", "a2"), device("cam-09", "normal", null)];

  it("所有区域都列出，按区域原顺序；不在区域或未登记的计入未分区", () => {
    const rows = areaDistribution([cyber("t1", "cam-01"), fall("t2", "cam-01"), fall("t3", "cam-09"), cyber("t4", null)], devices, [area("a1"), area("a2")]);
    expect(rows).toEqual([
      { name: "区域a1", cyber: 1, physical: 1 },
      { name: "区域a2", cyber: 0, physical: 0 },
      { name: "未分区", cyber: 1, physical: 1 },
    ]);
  });

  it(`超过 ${MAX_AREAS} 个区域时告警最少的并入"其他"`, () => {
    const areas = Array.from({ length: 7 }, (_, i) => area(`a${i}`));
    const devs = areas.map((a, i) => device(`cam-${i}`, "normal", a.id));
    const alerts = devs.flatMap((d, i) => Array.from({ length: i }, (_, k) => fall(`t${i}-${k}`, d.id)));
    const rows = areaDistribution(alerts, devs, areas);
    expect(rows).toHaveLength(MAX_AREAS);
    expect(rows.at(-1)).toEqual({ name: "其他", cyber: 0, physical: 0 + 1 + 2 });
  });
});

describe("设备运行与实时事件", () => {
  it("告警设备排在前面，网络优先于物理，正常的最后；状态给出文字", () => {
    const rows = deviceRows([device("c", "normal", "a"), device("b", "physical_alert", "a"), device("a", "cyber_alert", "a"), device("d", "offline", "a")]);
    expect(rows.map((r) => [r.id, r.tone, r.state])).toEqual([
      ["a", "cyber", "网络攻击"],
      ["b", "physical", "物理告警"],
      ["d", "muted", "离线"],
      ["c", "ok", "正常"],
    ]);
  });

  it("事件行：设备取名称，网络告警给严重度，疑似行为为疑似", () => {
    const devices = [device("cam-01", "normal", "a", "大门")];
    const rows = eventRows([cyber("2026-11-18T10:00:00Z", "cam-01", "critical"), fall("2026-11-18T09:00:00Z", "cam-01", "suspected"), cyber("2026-11-18T08:00:00Z", null)], devices);
    expect(rows.map((r) => [r.device, r.level, r.tone])).toEqual([
      ["大门", "严重", "cyber"],
      ["大门", "疑似", "muted"],
      ["未登记设备", "高", "cyber"],
    ]);
    expect(rows[1]?.title).toBe("疑似跌倒");
  });

  it("时刻格式为 MM/DD HH:mm:ss，无效时刻为 —", () => {
    expect(stamp(new Date(2026, 10, 8, 9, 5, 3).getTime())).toBe("11/08 09:05:03");
    expect(stamp(Number.NaN)).toBe("—");
  });

  it("目标数按人员与车辆分开", () => {
    const t = (object_class: string) => ({ object_class }) as Target;
    expect(targetCounts({ a: t("person"), b: t("car"), c: t("truck"), d: t("person") })).toEqual({ person: 2, vehicle: 2 });
  });
});

describe("3D 区域摆放", () => {
  it("按网格排开、区域间留空，整体以原点为中心", () => {
    const { placed, width, depth } = layoutAreas([area("a", 10, 8), area("b", 20, 8), area("c", 10, 12)]);
    expect(width).toBe(10 + 20 + GAP_M);
    expect(depth).toBe(8 + 12 + GAP_M);
    expect(placed[0]).toMatchObject({ x: -width / 2, z: -depth / 2 });
    // 第二列宽 20：区域 b 左边紧接第一列与间隔
    expect(placed[1]?.x).toBe(-width / 2 + 10 + GAP_M);
    // 第二行：区域 c 在第一列、下移第一行深度与间隔
    expect(placed[2]).toMatchObject({ x: -width / 2, z: -depth / 2 + 8 + GAP_M });
  });

  it("没有区域时为空", () => {
    expect(layoutAreas([])).toEqual({ placed: [], width: 0, depth: 0 });
  });
});

describe("告警巡检", () => {
  it("只巡检告警或处置中的已放置摄像头；没有时巡检全部已放置摄像头", () => {
    const devs = [device("a", "normal", "x"), device("b", "cyber_alert", "x"), device("c", "pending_action", "x"), device("d", "physical_alert", null)];
    expect(patrolList(devs)).toEqual({ ids: ["b", "c"], alerting: true });
    expect(patrolList([device("a", "normal", "x"), device("e", "normal", null)])).toEqual({ ids: ["a"], alerting: false });
  });
});

describe("图表辅助", () => {
  it("纵轴上限取整并分 4 格，全 0 时为 4", () => {
    expect(niceMax(0)).toBe(4);
    expect(niceMax(7)).toBe(8);
    expect(niceMax(37)).toBe(40);
    expect(niceMax(130)).toBe(200);
  });

  it("单调插值不越过相邻点：平台段保持水平", () => {
    const d = monotonePath([
      [0, 10],
      [10, 0],
      [20, 0],
      [30, 10],
    ]);
    const ys = [...d.matchAll(/-?\d+(?:\.\d+)?,(-?\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(0);
    expect(monotonePath([])).toBe("");
  });
});
