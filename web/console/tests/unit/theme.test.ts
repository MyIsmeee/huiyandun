import { beforeEach, describe, expect, it } from "vitest";
import { useTheme } from "../../src/theme/store";

const root = document.documentElement;

describe("主题（D-121：只有浅色）", () => {
  beforeEach(() => {
    localStorage.clear();
    useTheme.setState(useTheme.getInitialState());
  });

  it("页面根元素为浅色；降低动效立即生效", () => {
    useTheme.getState().setReducedMotion(true);
    expect(root.dataset).toMatchObject({ theme: "light", motion: "reduced" });
  });

  it("刷新后恢复降低动效开关", async () => {
    useTheme.getState().setReducedMotion(true);
    const saved = localStorage.getItem("hyd-theme");
    useTheme.setState(useTheme.getInitialState());
    localStorage.setItem("hyd-theme", saved ?? "");
    await useTheme.persist.rehydrate();
    expect(useTheme.getState().reducedMotion).toBe(true);
  });
});
