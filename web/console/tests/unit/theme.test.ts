import { beforeEach, describe, expect, it } from "vitest";
import { useTheme } from "../../src/theme/store";

const root = document.documentElement;

describe("主题", () => {
  beforeEach(() => {
    localStorage.clear();
    useTheme.setState(useTheme.getInitialState());
  });

  it("默认暗色、不降低动效", () => {
    expect(useTheme.getState()).toMatchObject({ theme: "dark", reducedMotion: false });
    expect(root.dataset).toMatchObject({ theme: "dark", motion: "full" });
  });

  it("切换后立即作用于页面根元素", () => {
    useTheme.getState().setTheme("light");
    useTheme.getState().setReducedMotion(true);

    expect(root.dataset).toMatchObject({ theme: "light", motion: "reduced" });
  });

  it("刷新后恢复上次的选择", async () => {
    useTheme.getState().setTheme("light");
    const saved = localStorage.getItem("hyd-theme");
    useTheme.setState(useTheme.getInitialState());
    localStorage.setItem("hyd-theme", saved ?? "");

    await useTheme.persist.rehydrate();

    expect(useTheme.getState().theme).toBe("light");
  });
});
