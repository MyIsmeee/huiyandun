import { afterEach, describe, expect, it, vi } from "vitest";

// 主视图在模块加载时从本机记录读取，每个用例重新加载模块
const load = async (stored: string | null) => {
  if (stored !== null) localStorage.setItem("hyd.main", stored);
  vi.resetModules();
  return (await import("../../src/store/nav")).useNav.getState();
};

describe("主视图记录", () => {
  afterEach(() => localStorage.clear());

  it("记住的态势照常恢复", async () => {
    expect(await load("overview")).toEqual({ page: "overview", main: "overview" });
  });

  it("记录为已删除的大屏时回到监控墙（D-144）", async () => {
    expect(await load("screen")).toEqual({ page: "wall", main: "wall" });
  });
});
