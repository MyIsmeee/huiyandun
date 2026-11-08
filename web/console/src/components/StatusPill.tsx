import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { STATUS } from "../scene/devices";

/**
 * 状态图标（设计 150 §4、V-S5）：状态色只用于图标、描边与填充，不作文字色。
 * 物理告警黄对白底约 1.8:1，图标改为黄色实心 + 深色描线（20 px），其余状态色描线即可（≥ 3:1）。
 */
export function StatusIcon({ icon: Icon, color, className }: { icon: LucideIcon; color?: string; className?: string }) {
  const solid = color === STATUS.physical;
  return (
    <Icon
      aria-hidden
      className={cn("size-3.5 shrink-0", solid && "size-5", className)}
      style={solid ? { fill: color, color: "var(--color-foreground)" } : { color }}
    />
  );
}

/** 药丸底色：状态色 12% 混入卡片色，不透明，叠在画面与场景上同样清晰 */
export const statusTint = (color: string) => `color-mix(in srgb, ${color} 12%, var(--color-card))`;

/** 状态药丸：状态色 12% 浅底 + 1 px 状态色描边 + 状态图标 + 深色字（设计 150 §4、V-S3） */
export function StatusPill(props: { icon: LucideIcon; color: string; role?: string; className?: string; children: ReactNode }) {
  const { icon, color, role, className, children } = props;
  return (
    <Badge
      variant="outline"
      role={role}
      style={{ borderColor: color, backgroundColor: statusTint(color) }}
      // Badge 默认把图标压到 12 px：普通状态 14 px，物理告警实心 20 px
      className={cn("gap-1.5 px-2.5 font-normal tabular-nums [&>svg]:size-3.5", color === STATUS.physical && "[&>svg]:size-5", className)}
    >
      <StatusIcon icon={icon} color={color} />
      {children}
    </Badge>
  );
}
