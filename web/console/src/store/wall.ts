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
}

/** 视图与宫格布局记在本地，刷新后保持（位置记忆，V-L1）；页码与放大只在本次会话内 */
export const useWall = create<WallState>()(
  persist(() => ({ view: "wall" as CanvasView, layout: "auto" as WallLayout, page: 0, zoomed: null as string | null }), {
    name: "hyd-wall",
    partialize: ({ view, layout }) => ({ view, layout }),
  }),
);

export const setView = (view: CanvasView) => useWall.setState({ view, zoomed: null });
export const setLayout = (layout: WallLayout) => useWall.setState({ layout, page: 0, zoomed: null });
export const setPage = (page: number) => useWall.setState({ page });
export const toggleZoom = (id: string) => useWall.setState((s) => ({ zoomed: s.zoomed === id ? null : id }));
