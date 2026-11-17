import { create } from "zustand";
import { persist } from "zustand/middleware";

/** 浅色为默认主题（ui.md §3、D-121）；夜间警戒是值班员手动切换的深色主题，大屏与界面一并变暗 */
export type Theme = "light" | "night";

interface ThemeState {
  /** 夜间警戒模式；主题由它决定（themeOf） */
  night: boolean;
  setNight: (night: boolean) => void;
  /** 用户开关；系统 prefers-reduced-motion 由 theme.css 另行响应（V-A4） */
  reducedMotion: boolean;
  setReducedMotion: (reducedMotion: boolean) => void;
}

export const useTheme = create<ThemeState>()(
  persist(
    (set) => ({
      night: false,
      setNight: (night) => set({ night }),
      reducedMotion: false,
      setReducedMotion: (reducedMotion) => set({ reducedMotion }),
    }),
    { name: "hyd-theme", partialize: ({ reducedMotion, night }) => ({ reducedMotion, night }) },
  ),
);

export const themeOf = ({ night }: Pick<ThemeState, "night">): Theme => (night ? "night" : "light");

/** JS 驱动的动效是否退化为瞬时切换：用户开关或系统 prefers-reduced-motion（V-A4） */
export function prefersReducedMotion(): boolean {
  return useTheme.getState().reducedMotion || matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function apply(state: ThemeState): void {
  const { reducedMotion } = state;
  const root = document.documentElement;
  root.dataset.theme = themeOf(state);
  root.dataset.motion = reducedMotion ? "reduced" : "full";
}

apply(useTheme.getState());
useTheme.subscribe(apply);
