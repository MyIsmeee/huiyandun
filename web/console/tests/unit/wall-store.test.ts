import { describe, expect, it } from "vitest";
import { setPage, toggleRail, toggleZoom, useWall } from "../../src/store/wall";

const stored = () => JSON.parse(localStorage.getItem("hyd-wall") ?? "{}").state as Record<string, unknown>;

describe("监控墙的位置记忆（V-L1）", () => {
  it("翻页、放大不把按视口算出的摄像头栏默认值记成用户的选择", () => {
    setPage(1);
    toggleZoom("cam-01");
    expect(stored().railChoice).toBeNull();
    expect(stored()).not.toHaveProperty("railCollapsed");
  });

  it("用户展开或收起后记下其选择，刷新后以其为准", async () => {
    const before = useWall.getState().railCollapsed;
    toggleRail();
    expect(stored().railChoice).toBe(!before);

    useWall.setState({ railCollapsed: before, railChoice: null });
    localStorage.setItem("hyd-wall", JSON.stringify({ state: { layout: "4", railChoice: !before }, version: 0 }));
    await useWall.persist.rehydrate();
    expect(useWall.getState()).toMatchObject({ layout: "4", railCollapsed: !before, railChoice: !before });
  });

  it("旧版本记下的 railCollapsed 不沿用", async () => {
    useWall.setState({ railCollapsed: false, railChoice: null });
    localStorage.setItem("hyd-wall", JSON.stringify({ state: { layout: "auto", railCollapsed: true }, version: 0 }));
    await useWall.persist.rehydrate();
    expect(useWall.getState()).toMatchObject({ railCollapsed: false, railChoice: null });
  });
});
