import { beforeEach, describe, expect, it, vi } from "vitest";
import type { components } from "../../src/api/schema";
import { api } from "../../src/lib/api";
import { ALARM_WINDOW_MS, pendingAlarms } from "../../src/panels/Alarm/Alarm";
import { dispose } from "../../src/panels/AlertList/Dispose";
import { type Alert, receive, useLive } from "../../src/store/live";

type Frame = components["schemas"]["WsFrame"];
const NOW = Date.parse("2026-11-17T08:00:00Z");
const at = (ms: number) => new Date(NOW - ms).toISOString();
const base = { schema_version: "1.2.0", camera_id: "cam-05", track_id: 4, level: "confirmed" };
const fall = (id: string, ago = 0, level = "confirmed") =>
  ({ ...base, event_id: id, ts: at(ago), behavior: "fall", level, ts_start: at(ago), ts_end: at(ago), confidence_avg: 0.9, duration_s: 8 }) as unknown as Alert;
const zone = (id: string, phase: string) => ({ ...base, event_id: id, ts: at(0), rule_type: "intrusion", rule_id: "yard", rule_name: "库区", phase, since: at(0) }) as unknown as Alert;
const network = { event_id: "n1", ts: at(0), device_id: "cam-05", rule_id: "HYD-NET-0001", severity: "critical" } as unknown as Alert;

beforeEach(() => useLive.setState(useLive.getInitialState()));

describe("告警弹窗的队列", () => {
  it("只含时间窗内、确认级、未处置、本机未关掉的物理告警；区域只在进入与越线时", () => {
    const alerts = [
      fall("a"),
      fall("old", ALARM_WINDOW_MS + 1),
      fall("suspect", 0, "suspected"),
      fall("done"),
      fall("closed"),
      zone("enter", "start"),
      zone("stay", "update"),
      network,
    ];
    const queue = pendingAlarms(alerts, { done: {} }, new Set(["closed"]), NOW);
    expect(queue.map((a) => a.event_id)).toEqual(["a", "enter"]);
  });
});

describe("告警处置", () => {
  it("推送的处置按 event_id 记下，同一告警以最近一次为准", () => {
    const frame = (action: string) => ({ channel: "dispositions", data: { event_id: "a", action, note: null, actor: "operator", ts: at(0) } }) as unknown as Frame;
    receive(frame("acknowledged"), NOW);
    receive(frame("false_positive"), NOW);
    expect(useLive.getState().dispositions.a?.action).toBe("false_positive");
  });

  it("合并行逐条提交，已是该处置的不重复提交", async () => {
    const call = vi.spyOn(api, "disposeAlert").mockResolvedValue({} as never);
    useLive.setState({ dispositions: { b: { event_id: "b", action: "resolved", note: null, actor: "operator", ts: at(0) } } });
    expect(await dispose([fall("a"), fall("b")], "resolved")).toBe(true);
    expect(call.mock.calls.map(([id, action]) => [id, action])).toEqual([["a", "resolved"]]);
  });
});
