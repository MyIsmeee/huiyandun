import { create } from "zustand";
import { persist } from "zustand/middleware";

export type Theme = "dark" | "light";

interface ThemeState {
  theme: Theme;
  /** 用户开关；系统 prefers-reduced-motion 由 theme.css 另行响应（V-A4） */
  reducedMotion: boolean;
  setTheme: (theme: Theme) => void;
  setReducedMotion: (reducedMotion: boolean) => void;
}

export const useTheme = create<ThemeState>()(
  persist(
    (set) => ({
      theme: "dark", // 暗色为默认（HYD-UIX-004 §3.1）
      reducedMotion: false,
      setTheme: (theme) => set({ theme }),
      setReducedMotion: (reducedMotion) => set({ reducedMotion }),
    }),
    { name: "hyd-theme" },
  ),
);

function apply({ theme, reducedMotion }: ThemeState): void {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.dataset.motion = reducedMotion ? "reduced" : "full";
}

apply(useTheme.getState());
useTheme.subscribe(apply);
