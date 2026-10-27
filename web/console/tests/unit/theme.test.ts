import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { syncAutoTheme, themeAt, useTheme } from "../../src/theme/store";

const root = document.documentElement;
const at = (hhmm: string) => new Date(`2026-10-27T${hhmm}:00`); // 本地时间

describe("主题", () => {
  beforeEach(() => {
    localStorage.clear();
    useTheme.setState(useTheme.getInitialState());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ["05:59", "dark"],
    ["06:00", "light"],
    ["17:59", "light"],
    ["18:00", "dark"],
  ])("自动档在本地 %s 为 %s", (hhmm, theme) => {
    expect(themeAt(at(hhmm))).toBe(theme);
  });

  it("默认自动档、不降低动效", () => {
    expect(useTheme.getState()).toMatchObject({ mode: "auto", reducedMotion: false });
  });

  it("手动选择后立即作用于页面根元素", () => {
    useTheme.getState().setMode("light");
    useTheme.getState().setReducedMotion(true);

    expect(root.dataset).toMatchObject({ theme: "light", motion: "reduced" });
  });

  it("自动档跨越时段边界时切换，手动档不随时间切换", () => {
    vi.useFakeTimers();
    vi.setSystemTime(at("17:59"));
    useTheme.getState().setMode("auto");
    expect(root.dataset.theme).toBe("light");

    vi.setSystemTime(at("18:00"));
    syncAutoTheme();
    expect(root.dataset.theme).toBe("dark");

    useTheme.getState().setMode("light");
    vi.setSystemTime(at("23:00"));
    syncAutoTheme();
    expect(root.dataset.theme).toBe("light");
  });

  it("刷新后恢复上次的档位，并按档位得出生效主题", async () => {
    useTheme.getState().setMode("dark");
    const saved = localStorage.getItem("hyd-theme");
    useTheme.setState(useTheme.getInitialState());
    localStorage.setItem("hyd-theme", saved ?? "");

    await useTheme.persist.rehydrate();

    expect(useTheme.getState()).toMatchObject({ mode: "dark", theme: "dark" });
    expect(saved).not.toContain('"theme"'); // 生效主题由时间得出，不保存
  });
});
