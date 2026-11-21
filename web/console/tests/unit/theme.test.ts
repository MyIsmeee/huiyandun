import { beforeEach, describe, expect, it } from "vitest";
import { DAY, NIGHT } from "../../src/scene/palette";
import css from "../../src/theme/theme.css?raw";
import { useTheme } from "../../src/theme/store";

const root = document.documentElement;

describe("主题（D-121：默认浅色；夜间警戒由值班员手动切换）", () => {
  beforeEach(() => {
    localStorage.clear();
    useTheme.setState(useTheme.getInitialState());
  });

  it("页面根元素默认为浅色；降低动效立即生效", () => {
    useTheme.getState().setReducedMotion(true);
    expect(root.dataset).toMatchObject({ theme: "light", motion: "reduced" });
  });

  it("夜间警戒立即生效，关闭后回到浅色", () => {
    useTheme.getState().setNight(true);
    expect(root.dataset.theme).toBe("night");
    useTheme.getState().setNight(false);
    expect(root.dataset.theme).toBe("light");
  });

  it("刷新后恢复降低动效与夜间警戒开关", async () => {
    useTheme.getState().setReducedMotion(true);
    useTheme.getState().setNight(true);
    const saved = localStorage.getItem("hyd-theme");
    useTheme.setState(useTheme.getInitialState());
    localStorage.setItem("hyd-theme", saved ?? "");
    await useTheme.persist.rehydrate();
    expect(useTheme.getState()).toMatchObject({ reducedMotion: true, night: true });
    expect(root.dataset.theme).toBe("night");
  });

  it("场景背景与页面底色一致：日间、夜间各取其主题的 --background", () => {
    const light = /:root \{[^}]*--background: (#[0-9a-f]{6});/i.exec(css)?.[1];
    const night = /\[data-theme="night"\] \{[^}]*--background: (#[0-9a-f]{6});/i.exec(css)?.[1];
    expect(DAY.background.toLowerCase()).toBe(light);
    expect(NIGHT.background.toLowerCase()).toBe(night);
  });
});
