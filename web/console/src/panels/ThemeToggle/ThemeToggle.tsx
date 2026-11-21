import { Moon, Zap, ZapOff } from "lucide-react";
import { Toggle } from "@/components/ui/toggle";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useTheme } from "../../theme/store";

const toggle = "text-muted-foreground hover:bg-secondary hover:text-foreground";

/** 夜间警戒开关（界面与大屏一并切换为深色）与降低动效开关（V-A4）；默认浅色主题（D-121） */
export function ThemeToggle() {
  const { night, setNight, reducedMotion, setReducedMotion } = useTheme();
  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Toggle size="sm" aria-label="夜间警戒" pressed={night} onPressedChange={setNight} className={toggle}>
            <Moon />
          </Toggle>
        </TooltipTrigger>
        <TooltipContent>夜间警戒</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Toggle size="sm" aria-label="降低动效" pressed={reducedMotion} onPressedChange={setReducedMotion} className={toggle}>
            {reducedMotion ? <ZapOff /> : <Zap />}
          </Toggle>
        </TooltipTrigger>
        <TooltipContent>降低动效</TooltipContent>
      </Tooltip>
    </>
  );
}
