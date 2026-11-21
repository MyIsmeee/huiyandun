import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { WallLayout } from "../panels/VideoWall/grid";

interface WallState {
  layout: WallLayout;
  page: number;
  /** 双击临时放大为 1×1 的摄像头（V-W4），不持久化 */
  zoomed: string | null;
  /** 摄像头栏收起为图标栏（ui.md §4）：用户选过时取其选择，否则按视口宽度 */
  railCollapsed: boolean;
  /** 用户展开或收起摄像头栏的选择；未选过为 null */
  railChoice: boolean | null;
}

/** 视口窄于此宽度时摄像头栏默认收起，主画布仍占一半以上（V-L2）；用户展开或收起后以其选择为准 */
const RAIL_MIN_VIEWPORT = 1600;
const railDefault = () => innerWidth < RAIL_MIN_VIEWPORT;

type Persisted = Partial<Pick<WallState, "layout" | "railChoice">>;

/**
 * 宫格布局与用户对摄像头栏的选择记在本地，刷新后保持（位置记忆，V-L1）；页码与放大只在本次会话内。
 * 只记用户的选择，不记按视口算出的默认值：翻页、放大等任何状态变化都会触发写入，记下默认值后换了屏幕宽度不再按新视口默认
 */
export const useWall = create<WallState>()(
  persist(
    (): WallState => ({ layout: "auto", page: 0, zoomed: null, railCollapsed: railDefault(), railChoice: null }),
    {
      name: "hyd-wall",
      partialize: ({ layout, railChoice }): Persisted => ({ layout, railChoice }),
      // 旧版本记下的 railCollapsed 可能是默认值，不沿用
      merge: (persisted, current) => {
        const { layout, railChoice } = (persisted ?? {}) as Persisted;
        const choice = typeof railChoice === "boolean" ? railChoice : null;
        return { ...current, layout: layout ?? current.layout, railChoice: choice, railCollapsed: choice ?? current.railCollapsed };
      },
    },
  ),
);

export const setLayout = (layout: WallLayout) => useWall.setState({ layout, page: 0, zoomed: null });
export const setPage = (page: number) => useWall.setState({ page });
export const toggleZoom = (id: string) => useWall.setState((s) => ({ zoomed: s.zoomed === id ? null : id }));
export const toggleRail = () => useWall.setState((s) => ({ railCollapsed: !s.railCollapsed, railChoice: !s.railCollapsed }));
