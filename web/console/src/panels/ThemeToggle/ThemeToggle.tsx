import { type LucideIcon, Moon, Sun, SunMoon, Zap, ZapOff } from "lucide-react";
import type { ReactNode } from "react";
import { type ThemeMode, useTheme } from "../../theme/store";

const MODES: [ThemeMode, LucideIcon, string][] = [
  ["auto", SunMoon, "主题：自动（06:00–18:00 亮色）"],
  ["dark", Moon, "主题：暗色"],
  ["light", Sun, "主题：亮色"],
];

/** 主题三档（HYD-UIX-004 §3.1）与降低动效（V-A4） */
export function ThemeToggle() {
  const { mode, reducedMotion, setMode, setReducedMotion } = useTheme();
  return (
    <div className="flex items-center rounded-full border border-line p-0.5">
      <div role="radiogroup" aria-label="主题" className="flex items-center">
        {MODES.map(([value, Icon, label]) => (
          <IconButton key={value} label={label} checked={mode === value} onClick={() => setMode(value)}>
            <Icon className="size-4" />
          </IconButton>
        ))}
      </div>
      <span aria-hidden className="mx-0.5 h-4 w-px bg-line" />
      <IconButton label="降低动效" pressed={reducedMotion} onClick={() => setReducedMotion(!reducedMotion)}>
        {reducedMotion ? <ZapOff className="size-4" /> : <Zap className="size-4" />}
      </IconButton>
    </div>
  );
}

function IconButton(props: {
  label: string;
  checked?: boolean;
  pressed?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      role={props.checked === undefined ? undefined : "radio"}
      aria-checked={props.checked}
      aria-label={props.label}
      title={props.label}
      aria-pressed={props.pressed}
      onClick={props.onClick}
      className="grid size-8 place-items-center rounded-full text-fg-2 transition-colors hover:bg-raised hover:text-fg aria-checked:bg-raised aria-checked:text-fg aria-pressed:bg-raised aria-pressed:text-fg"
    >
      {props.children}
    </button>
  );
}
