import { beforeEach, describe, expect, it } from "vitest";
import type { components } from "../../src/api/schema";
import { blink, markText } from "../../src/panels/DetectionOverlay/overlay";
import { clip, homography, pinhole, zones } from "../../src/panels/DetectionOverlay/zones";
import { type Mark, PULSE_MARK_MS, prune, receive, SUSPECT_MARK_MS, useLive } from "../../src/store/live";

type Frame = components["schemas"]["WsFrame"];
type CameraInfo = components["schemas"]["CameraInfo"];
const frame = (channel: Frame["channel"], data: object) => ({ channel, data }) as unknown as Frame;
const BASE = { schema_version: "1.0.0", ts: "2026-10-27T06:30:10Z", camera_id: "cam-01", track_id: 1 };
const T0 = Date.parse("2026-10-27T06:30:00Z");
const behavior = (level: "suspected" | "confirmed", event_id = "e1") =>
  frame("alerts", { ...BASE, event_id, behavior: "fall", level, ts_start: "2026-10-27T06:30:00Z", ts_end: "2026-10-27T06:30:08Z" });
const rule = (phase: "start" | "update" | "end" | "pulse", rule_type = "intrusion", event_id = `r-${phase}`) =>
  frame("alerts", { ...BASE, event_id, rule_id: "yard", rule_name: "库区", rule_type, phase, level: "confirmed", since: "2026-10-27T06:30:02Z" });
const mark = () => useLive.getState().marks["cam-01/1"];
const track = (now: number) =>
  receive(
    frame("tracks", { ...BASE, object_class: "person", x: 1, y: 1, uncertainty_m: 0.3, heading_deg: null, speed_mps: null, bbox: [0, 0, 1, 1], keypoints: null }),
    now,
  );

beforeEach(() => useLive.setState(useLive.getInitialState()));

describe("画面告警标记", () => {
  it("疑似跌倒标记 10 s 后撤下；确认后持续，之后的疑似事件不覆盖", () => {
    const now = T0 + 3000;
    receive(behavior("suspected"), now);
    expect(mark()).toMatchObject({ kind: "fall", level: "suspected", since: T0, until: now + SUSPECT_MARK_MS });

    receive(behavior("confirmed", "e2"), now + 5000);
    receive(behavior("suspected", "e3"), now + 6000);
    expect(mark()).toMatchObject({ level: "confirmed", until: null });
  });

  it("设备退出物理告警即撤下行为标记；区域标记不受影响，随规则的 end 撤下", () => {
    receive(behavior("confirmed"), T0);
    receive(frame("devices", { id: "cam-01", state: "normal" }), T0);
    expect(mark()).toBeUndefined();

    receive(rule("start"), T0);
    receive(frame("devices", { id: "cam-01", state: "normal" }), T0);
    expect(mark()).toMatchObject({ kind: "intrusion", name: "库区", since: T0 + 2000, until: null });
    receive(rule("end"), T0);
    expect(mark()).toBeUndefined();
  });

  it("越线只标记 5 s；到期与人已离开画面（宽限后）的标记由 prune 撤下", () => {
    track(T0);
    receive(rule("pulse", "line_crossing"), T0);
    expect(mark()?.until).toBe(T0 + PULSE_MARK_MS);
    prune(T0 + 1000);
    expect(mark()).toBeDefined();
    track(T0 + PULSE_MARK_MS);
    prune(T0 + PULSE_MARK_MS + 1);
    expect(mark()).toBeUndefined();

    receive(behavior("confirmed"), T0 + 10_000); // 人不在画面上
    prune(T0 + 11_000);
    expect(mark()).toBeDefined(); // 行为事件可能早于位置到达：宽限
    prune(T0 + 13_000);
    expect(mark()).toBeUndefined();
  });

  it("标签为行为、规则名与已持续秒数；疑似加前缀，越线不计时", () => {
    const base: Mark = { camera_id: "cam-01", track_id: 1, kind: "fall", level: "confirmed", name: null, since: 0, until: null, seen: 0 };
    expect(markText(base, 8_900)).toBe("跌倒 · 8 秒");
    expect(markText({ ...base, level: "suspected" }, 2_000)).toBe("疑似跌倒 · 2 秒");
    expect(markText({ ...base, kind: "intrusion", name: "库区" }, 12_000)).toBe("区域入侵 · 库区 · 12 秒");
    expect(markText({ ...base, kind: "line_crossing", name: "大门" }, 3_000)).toBe("越线 · 大门");
    expect(markText(base, -500)).toBe("跌倒 · 0 秒"); // 时钟略有偏差时不出现负数
  });

  it("闪烁的不透明度在 0.35 与 1 之间，每秒一个周期", () => {
    expect(blink(0)).toBeCloseTo(1);
    expect(blink(500)).toBeCloseTo(0.35);
    expect(blink(1000)).toBeCloseTo(1);
  });
});

const POSE = { x: 0, y: 0, height_m: 3, yaw_deg: 0, pitch_deg: -30, hfov_deg: 90, range_m: 15 };
const SIZE = [1280, 720] as const;

describe("区域投到画面", () => {
  it("针孔模型：光轴落地点在画面中心，平面 +y（朝向的右手侧）在画面右方，近处在画面下方", () => {
    const project = pinhole(POSE, SIZE);
    const ahead = 3 / Math.tan(Math.PI / 6);
    const [u, v, depth] = project(ahead, 0);
    expect([u, v]).toEqual([expect.closeTo(0.5, 6), expect.closeTo(0.5, 6)]);
    expect(depth).toBeGreaterThan(0);
    expect(project(ahead, 1)[0]).toBeGreaterThan(0.5);
    expect(project(ahead - 2, 0)[1]).toBeGreaterThan(0.5);
    expect(project(-3, 0)[2]).toBeLessThan(0); // 摄像头背后
  });

  it("按标定点拟合的单应与生成标定点的投影一致", () => {
    const truth = pinhole(POSE, SIZE);
    const calibration = [
      [3, -2],
      [3, 2],
      [8, -3],
      [8, 3],
      [5, 0],
      [10, 1],
    ].map(([x = 0, y = 0]) => {
      const [u, v] = truth(x, y);
      return [u * SIZE[0], v * SIZE[1], x, y];
    });
    const fitted = homography(calibration, SIZE);
    for (const [x, y] of [
      [6, -1],
      [12, 2],
    ] as const) {
      const [a, b] = [fitted?.(x, y), truth(x, y)];
      expect(a?.[0]).toBeCloseTo(b[0], 6);
      expect(a?.[1]).toBeCloseTo(b[1], 6);
      expect(a?.[2]).toBeGreaterThan(0);
    }
  });

  it("跨到摄像头背后的多边形与折线被裁掉背后的部分", () => {
    const project = pinhole(POSE, SIZE);
    const [polygon] = clip(
      [
        [-4, -1],
        [6, -1],
        [6, 1],
        [-4, 1],
      ],
      project,
      true,
    );
    expect(polygon?.length).toBe(4);
    for (const [u, v] of polygon ?? []) expect(Number.isFinite(u) && Number.isFinite(v)).toBe(true);
    const lines = clip(
      [
        [6, 0],
        [-4, 0],
        [6, 2],
      ],
      project,
      false,
    );
    expect(lines.length).toBe(2); // 中间经过摄像头背后，断成两段
  });

  it("攀爬警戒线按像素换算；规则按地面映射投影，越线带正向箭头", () => {
    const camera = {
      stream: "cam-01",
      area_id: null,
      pose: POSE,
      calibration: [],
      mapping: "estimated",
      homography: null,
      reproj_error_m: null,
      climb_lines: [[128, 360, 640, 180]],
      rules: [
        { id: "yard", name: "库区", type: "intrusion", points: [[4, -1], [7, -1], [7, 1]] },
        { id: "gate", name: "大门", type: "line_crossing", points: [[5, -2], [5, 2]], direction: "forward" },
      ],
    } as unknown as CameraInfo;
    const [climb, zone, line] = zones(camera, SIZE);
    expect(climb?.paths).toEqual([[[0.1, 0.5], [0.5, 0.25]]]);
    expect(zone?.paths[0]?.length).toBe(3);
    // 沿 +y 前进，左侧为 +x（远离摄像头）：箭头指向画面上方
    const [from, to] = line?.arrow ?? [[0, 0], [0, 0]];
    expect(to[1]).toBeLessThan(from[1]);
  });
});
