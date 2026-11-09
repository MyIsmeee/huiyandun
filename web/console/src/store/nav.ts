import { create } from "zustand";

/** 顶栏导航的页面（设计 150 §3）：态势为默认页，监控墙为独立视图（D-122）；其余为管理页 */
export type Page = "overview" | "wall" | "cameras" | "scene" | "providers";

/**
 * 当前页面。main 为最近打开的态势或监控墙：管理页盖在它之上而不替换它，
 * 场景与推送保持运行，返回时无需重新加载
 */
export const useNav = create<{ page: Page; main: "overview" | "wall" }>()(() => ({ page: "overview", main: "overview" }));

export const go = (page: Page) =>
  useNav.setState(page === "overview" || page === "wall" ? { page, main: page } : { page });
