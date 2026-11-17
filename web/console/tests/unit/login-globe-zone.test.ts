import { describe, expect, it } from "vitest";
import table from "../../src/panels/LoginPage/globe/zones.json";
import { DEG, formatLocation, type ZoneTable, zoneLocation } from "../../src/panels/LoginPage/globe/motion";

const zones = table as ZoneTable;

describe("登录俯冲按时区定位", () => {
  it("时区取代表城市坐标：Asia/Shanghai 为上海", () => {
    const home = zoneLocation("Asia/Shanghai", zones);
    expect((home?.lat ?? 0) / DEG).toBeCloseTo(31.23, 1);
    expect((home?.lng ?? 0) / DEG).toBeCloseTo(121.47, 1);
  });

  it("旧名经别名找到同一地点：Asia/Chongqing 同上海，Asia/Calcutta 同 Asia/Kolkata", () => {
    expect(zoneLocation("Asia/Chongqing", zones)).toEqual(zoneLocation("Asia/Shanghai", zones));
    expect(zoneLocation("Asia/Calcutta", zones)).toEqual(zoneLocation("Asia/Kolkata", zones));
  });

  it("不对应地点的时区与缺省时返回 null，俯冲照旧锁定覆盖区所在地块", () => {
    expect(zoneLocation("UTC", zones)).toBeNull();
    expect(zoneLocation("Etc/GMT-8", zones)).toBeNull();
    expect(zoneLocation(undefined, zones)).toBeNull();
  });

  it("坐标文字按南北、东西半球标注", () => {
    expect(formatLocation({ lat: 31.2333 * DEG, lng: 121.4667 * DEG })).toBe("31.23°N 121.47°E");
    expect(formatLocation({ lat: -33.8667 * DEG, lng: -46.6167 * DEG })).toBe("33.87°S 46.62°W");
  });
});

describe("飞向本地的转向", () => {
  it("按最近的方向转，至多半圈", async () => {
    const { nearestAngle } = await import("../../src/panels/LoginPage/globe/motion");
    expect(nearestAngle(0.4, 0)).toBeCloseTo(0); // 刚转过正面：倒回 0.4，而不是再转 2π − 0.4
    expect(nearestAngle(0, 1)).toBeCloseTo(1);
    expect(nearestAngle(10, 0)).toBeCloseTo(4 * Math.PI); // 同余且离 10 最近
    expect(Math.abs(nearestAngle(3, -2) - 3)).toBeLessThanOrEqual(Math.PI);
  });
});
