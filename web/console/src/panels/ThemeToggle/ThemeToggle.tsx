import { Zap, ZapOff } from "lucide-react";
import type { ReactNode } from "react";
import { useTheme } from "../../theme/store";

/** 降低动效开关（V-A4）；主题只有石墨暗色一套（D-110） */
export function ThemeToggle() {
  const { reducedMotion, setReducedMotion } = useTheme();
  return (
    <div className="flex items-center">
      <IconButton label="降低动效" pressed={reducedMotion} onClick={() => setReducedMotion(!reducedMotion)}>
        {reducedMotion ? <ZapOff className="size-4" /> : <Zap className="size-4" />}
      </IconButton>
    </div>
  );
}

function IconButton(props: { label: string; pressed: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      aria-label={props.label}
      title={props.label}
      aria-pressed={props.pressed}
      onClick={props.onClick}
      className="grid size-8 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground aria-pressed:bg-accent aria-pressed:text-foreground"
    >
      {props.children}
    </button>
  );
}
