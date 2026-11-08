import { Zap, ZapOff } from "lucide-react";
import { Toggle } from "@/components/ui/toggle";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useTheme } from "../../theme/store";

/** 降低动效开关（V-A4）；主题只有浅色一套（D-121） */
export function ThemeToggle() {
  const { reducedMotion, setReducedMotion } = useTheme();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Toggle
          size="sm"
          aria-label="降低动效"
          pressed={reducedMotion}
          onPressedChange={setReducedMotion}
          className="text-muted-foreground hover:bg-secondary hover:text-foreground"
        >
          {reducedMotion ? <ZapOff /> : <Zap />}
        </Toggle>
      </TooltipTrigger>
      <TooltipContent>降低动效</TooltipContent>
    </Tooltip>
  );
}
