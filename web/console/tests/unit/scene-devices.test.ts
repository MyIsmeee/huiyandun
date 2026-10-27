import { describe, expect, it } from "vitest";
import { type DeviceState, deviceLook, STATUS } from "../../src/scene/devices";

const STATES: DeviceState[] = [
  "normal",
  "offline",
  "uncalibrated",
  "physical_alert",
  "cyber_alert",
  "both",
  "pending_action",
  "contained",
  "notify_only",
];
const ALERT_COLORS: string[] = [STATUS.physical, STATUS.cyber, STATUS.contained];

describe("deviceLook（§5.2）", () => {
  it.each(STATES)("%s：出现状态色时同时有图标与文字标签（V-S3）", (state) => {
    const look = deviceLook(state);
    const colors = [look.fill, look.outline?.color, look.ring, look.cone?.color];

    if (colors.some((c) => c && ALERT_COLORS.includes(c))) expect(look.tags.length).toBeGreaterThan(0);
    for (const tag of look.tags) expect(tag.text).not.toBe("");
  });

  it("正常态为中性色、无标签（V-S1）", () => {
    expect(deviceLook("normal")).toMatchObject({ fill: STATUS.neutral, cone: { color: STATUS.neutral, opacity: 0.12 } });
    expect(deviceLook("normal").tags).toEqual([]);
  });

  it("离线与未标定隐藏视场；离线半透明，未标定为虚线轮廓", () => {
    expect(deviceLook("offline")).toMatchObject({ opacity: 0.5, cone: null });
    expect(deviceLook("uncalibrated")).toMatchObject({ outline: { dashed: true }, cone: null });
  });

  it("同时命中：网络攻击色 + 物理告警轮廓环，两个标签", () => {
    const look = deviceLook("both");

    expect(look).toMatchObject({ fill: STATUS.cyber, ring: STATUS.physical });
    expect(look.tags.map((t) => t.text)).toEqual(["网络攻击", "物理告警"]);
  });

  it("只有网络攻击中的视场呼吸（V-A1）", () => {
    const breathing = STATES.filter((s) => deviceLook(s).cone?.breathe);

    expect(breathing).toEqual(["cyber_alert", "both"]);
  });

  it("处置中只画绿色虚线轮廓不填充；已处置视场恢复中性", () => {
    expect(deviceLook("pending_action")).toMatchObject({ fill: null, outline: { color: STATUS.contained, dashed: true } });
    expect(deviceLook("contained").cone?.color).toBe(STATUS.neutral);
  });

  it("旁路模式显示\"已通知 · 待联动\"，不显示\"已阻断\"（V-T1）", () => {
    const texts = STATES.flatMap((s) => deviceLook(s).tags.map((t) => t.text));

    expect(texts).toContain("已通知 · 待联动");
    expect(texts.join()).not.toContain("阻断");
  });
});
