import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { WallLayout } from "../panels/VideoWall/grid";

/** 主画布视图（D-115）：监控墙为默认，空间态势为 3D */
export type CanvasView = "wall" | "space";

interface WallState {
  view: CanvasView;
  layout: WallLayout;
  page: number;
  /** 双击临时放大为 1×1 的摄像头（V-W4），不持久化 */
  zoomed: string | null;
  /** 摄像头栏收起为图标栏（04 §4.1 B 区） */
  railCollapsed: boolean;
}

/** 视口窄于此宽度时摄像头栏默认收起，主画布仍占一半以上（V-L2）；用户展开或收起后以其选择为准 */
const RAIL_MIN_VIEWPORT = 1600;

/** 视图、宫格布局与摄像头栏收起记在本地，刷新后保持（位置记忆，V-L1）；页码与放大只在本次会话内 */
export const useWall = create<WallState>()(
  persist(
    (): WallState => ({ view: "wall", layout: "auto", page: 0, zoomed: null, railCollapsed: innerWidth < RAIL_MIN_VIEWPORT }),
    { name: "hyd-wall", partialize: ({ view, layout, railCollapsed }) => ({ view, layout, railCollapsed }) },
  ),
);

export const setView = (view: CanvasView) => useWall.setState({ view, zoomed: null });
export const setLayout = (layout: WallLayout) => useWall.setState({ layout, page: 0, zoomed: null });
export const setPage = (page: number) => useWall.setState({ page });
export const toggleZoom = (id: string) => useWall.setState((s) => ({ zoomed: s.zoomed === id ? null : id }));
export const toggleRail = () => useWall.setState((s) => ({ railCollapsed: !s.railCollapsed }));
