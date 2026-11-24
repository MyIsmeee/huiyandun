import { create } from "zustand";

/**
 * 顶栏导航的页面（ui.md §4）：监控墙为默认页（画面上直接标出告警，值班员最直观），态势为 3D 总览（D-122）；
 * 其余为管理页
 */
export type Page = MainPage | AdminPage;
/** 主页面：管理页盖在其上 */
export type MainPage = "overview" | "wall";
/** 管理页（admin）：顶栏的"管理"进入，左侧栏切换（ui.md §4） */
export type AdminPage = "cameras" | "scene" | "providers";

/**
 * 当前页面。main 为最近打开的态势或监控墙：管理页盖在它之上而不替换它，
 * 场景与推送保持运行，返回时无需重新加载
 */
/** 本机记住上次看的是监控墙还是态势，下次登录回到那里；没有记录或记录为已删除的大屏（D-144）时为监控墙 */
const MAIN_KEY = "hyd.main";
const MAINS: readonly string[] = ["overview", "wall"] satisfies MainPage[];
export const isMainPage = (page: string | null): page is MainPage => page !== null && MAINS.includes(page);
const remembered = (): MainPage => {
  const page = localStorage.getItem(MAIN_KEY);
  return isMainPage(page) ? page : "wall";
};

export const useNav = create<{ page: Page; main: MainPage }>()(() => {
  const main = remembered();
  return { page: main, main };
});

export const go = (page: Page) => {
  if (isMainPage(page)) localStorage.setItem(MAIN_KEY, page);
  useNav.setState(isMainPage(page) ? { page, main: page } : { page });
};
