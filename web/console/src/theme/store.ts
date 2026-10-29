import { create } from "zustand";
import { persist } from "zustand/middleware";

export type Theme = "dark" | "light";
export type ThemeMode = "auto" | Theme;

/** HYD-UIX-004 §3.1：自动档按浏览器本地时间，06:00–18:00 为亮色，其余为暗色 */
export function themeAt(date: Date): Theme {
  const hour = date.getHours();
  return hour >= 6 && hour < 18 ? "light" : "dark";
}

const resolve = (mode: ThemeMode): Theme => (mode === "auto" ? themeAt(new Date()) : mode);

interface ThemeState {
  /** 用户选择的档位，默认亮色；选择后记住 */
  mode: ThemeMode;
  /** 当前生效的主题 */
  theme: Theme;
  /** 用户开关；系统 prefers-reduced-motion 由 theme.css 另行响应（V-A4） */
  reducedMotion: boolean;
  setMode: (mode: ThemeMode) => void;
  setReducedMotion: (reducedMotion: boolean) => void;
}

export const useTheme = create<ThemeState>()(
  persist(
    (set) => ({
      mode: "light",
      theme: "light",
      reducedMotion: false,
      setMode: (mode) => set({ mode, theme: resolve(mode) }),
      setReducedMotion: (reducedMotion) => set({ reducedMotion }),
    }),
    {
      name: "hyd-theme",
      // 生效主题由档位与时间得出，不保存
      partialize: ({ mode, reducedMotion }) => ({ mode, reducedMotion }),
      onRehydrateStorage: () => (state) => state?.setMode(state.mode),
    },
  ),
);

/** JS 驱动的动效是否退化为瞬时切换：用户开关或系统 prefers-reduced-motion（V-A4） */
export function prefersReducedMotion(): boolean {
  return useTheme.getState().reducedMotion || matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** 自动档跨越时段边界时切换主题，每分钟检查一次 */
export function syncAutoTheme(): void {
  const { mode, theme } = useTheme.getState();
  if (mode === "auto" && theme !== themeAt(new Date())) useTheme.setState({ theme: themeAt(new Date()) });
}

function apply({ theme, reducedMotion }: ThemeState): void {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.dataset.motion = reducedMotion ? "reduced" : "full";
}

apply(useTheme.getState());
useTheme.subscribe(apply);
setInterval(syncAutoTheme, 60_000);
