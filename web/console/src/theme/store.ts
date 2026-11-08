import { create } from "zustand";
import { persist } from "zustand/middleware";

/** 只有浅色一套主题（ui.md §3、D-121） */
export type Theme = "light";

interface ThemeState {
  theme: Theme;
  /** 用户开关；系统 prefers-reduced-motion 由 theme.css 另行响应（V-A4） */
  reducedMotion: boolean;
  setReducedMotion: (reducedMotion: boolean) => void;
}

export const useTheme = create<ThemeState>()(
  persist(
    (set) => ({
      theme: "light",
      reducedMotion: false,
      setReducedMotion: (reducedMotion) => set({ reducedMotion }),
    }),
    { name: "hyd-theme", partialize: ({ reducedMotion }) => ({ reducedMotion }) },
  ),
);

/** JS 驱动的动效是否退化为瞬时切换：用户开关或系统 prefers-reduced-motion（V-A4） */
export function prefersReducedMotion(): boolean {
  return useTheme.getState().reducedMotion || matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function apply({ reducedMotion }: ThemeState): void {
  const root = document.documentElement;
  root.dataset.theme = "light";
  root.dataset.motion = reducedMotion ? "reduced" : "full";
}

apply(useTheme.getState());
useTheme.subscribe(apply);
