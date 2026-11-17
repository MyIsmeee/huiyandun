import { create } from "zustand";

/** 顶栏导航的页面（设计 150 §3）：监控墙为默认页（画面上直接标出告警，值班员最直观），态势为 3D 总览（D-122）；其余为管理页 */
export type Page = "overview" | "wall" | AdminPage;
/** 管理页（admin）：顶栏的"管理"进入，左侧栏切换（设计 150 §9A） */
export type AdminPage = "cameras" | "scene" | "providers";

/**
 * 当前页面。main 为最近打开的态势或监控墙：管理页盖在它之上而不替换它，
 * 场景与推送保持运行，返回时无需重新加载
 */
/** 本机记住上次看的是监控墙还是态势，下次登录回到那里；没有记录时为监控墙 */
const MAIN_KEY = "hyd.main";
const remembered = (): "overview" | "wall" => (localStorage.getItem(MAIN_KEY) === "overview" ? "overview" : "wall");

export const useNav = create<{ page: Page; main: "overview" | "wall" }>()(() => {
  const main = remembered();
  return { page: main, main };
});

export const go = (page: Page) => {
  if (page === "overview" || page === "wall") localStorage.setItem(MAIN_KEY, page);
  useNav.setState(page === "overview" || page === "wall" ? { page, main: page } : { page });
};
