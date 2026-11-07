import { Zap, ZapOff } from "lucide-react";
import { Toggle } from "@/components/ui/toggle";
import { useTheme } from "../../theme/store";

/** 降低动效开关（V-A4）；主题只有石墨暗色一套（D-110） */
export function ThemeToggle() {
  const { reducedMotion, setReducedMotion } = useTheme();
  return (
    <Toggle
      size="sm"
      aria-label="降低动效"
      title="降低动效"
      pressed={reducedMotion}
      onPressedChange={setReducedMotion}
      className="text-muted-foreground hover:bg-secondary hover:text-foreground"
    >
      {reducedMotion ? <ZapOff /> : <Zap />}
    </Toggle>
  );
}
