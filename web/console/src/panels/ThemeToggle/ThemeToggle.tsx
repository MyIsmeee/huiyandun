import { Moon, Sun, Zap, ZapOff } from "lucide-react";
import type { ReactNode } from "react";
import { useTheme } from "../../theme/store";

/** 主题与降低动效（V-A4） */
export function ThemeToggle() {
  const { theme, reducedMotion, setTheme, setReducedMotion } = useTheme();
  const dark = theme === "dark";
  return (
    <div className="flex items-center rounded-full border border-line p-0.5">
      <IconButton label={dark ? "切换到亮色" : "切换到暗色"} onClick={() => setTheme(dark ? "light" : "dark")}>
        {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
      </IconButton>
      <IconButton label="降低动效" pressed={reducedMotion} onClick={() => setReducedMotion(!reducedMotion)}>
        {reducedMotion ? <ZapOff className="size-4" /> : <Zap className="size-4" />}
      </IconButton>
    </div>
  );
}

function IconButton(props: { label: string; pressed?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      aria-label={props.label}
      title={props.label}
      aria-pressed={props.pressed}
      onClick={props.onClick}
      className="grid size-8 place-items-center rounded-full text-fg-2 transition-colors hover:bg-raised hover:text-fg aria-pressed:bg-raised aria-pressed:text-fg"
    >
      {props.children}
    </button>
  );
}
