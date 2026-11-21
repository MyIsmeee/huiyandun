import { toast } from "sonner";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { components } from "../../api/schema";
import { ApiError, api } from "../../lib/api";
import { type Alert, isPhysical, useLive } from "../../store/live";
import { alertText } from "./AlertList";
import { ClipButton } from "./ClipDialog";
import { canContain, useSession } from "../../store/session";
import { formatStamp } from "../ConnectionStatus/ConnectionStatus";

export type DispositionAction = components["schemas"]["DispositionAction"];

export const DISPOSITION: Record<DispositionAction, string> = { acknowledged: "已确认", false_positive: "误报", resolved: "已处理" };
const ACTIONS: DispositionAction[] = ["acknowledged", "false_positive", "resolved"];

/** 对一组告警（合并行）提交处置：组内尚未是该处置的逐条提交；失败时提示原因 */
export async function dispose(alerts: Alert[], action: DispositionAction): Promise<boolean> {
  const { dispositions } = useLive.getState();
  const todo = alerts.filter((a) => dispositions[a.event_id]?.action !== action);
  try {
    await Promise.all(todo.map((a) => api.disposeAlert(a.event_id, action)));
    return true;
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : "处置未提交，请检查网络后重试");
    return false;
  }
}

/**
 * 告警处置条（告警闭环）：显示组内最新一条的处置状态（处置、处置人、时刻）；operator 及以上可标已确认、误报、已处理。
 * 已确认后仍可改为误报或已处理；viewer 只看状态（C-FE-07）。摄像头告警另可回放前后的录像
 */
export function DisposeBar({ alerts, className }: { alerts: Alert[]; className?: string }) {
  const role = useSession((s) => s.role);
  const latest = alerts[0];
  const current = useLive((s) => (latest ? s.dispositions[latest.event_id] : undefined));
  const [pending, setPending] = useState(false);
  if (!latest) return null;
  const allowed = canContain(role);
  const shown = ACTIONS.filter((a) => a !== current?.action && !(a === "acknowledged" && current));
  const physical = isPhysical(latest);
  if (!current && !allowed && !physical) return null;
  return (
    <div className={cn("flex flex-wrap items-center gap-1.5 text-xs", className)}>
      {current && (
        <span
          className={cn(
            "rounded-sm border px-1.5 py-0.5",
            current.action === "false_positive" ? "border-dashed text-muted-foreground" : "text-foreground",
          )}
          title={current.note ?? undefined}
        >
          {DISPOSITION[current.action]} · {current.actor} · {formatStamp(Date.parse(current.ts))}
        </span>
      )}
      {allowed &&
        shown.map((action) => (
          <Button
            key={action}
            variant="outline"
            size="sm"
            disabled={pending}
            className="h-6 px-2 text-xs"
            onClick={async (e) => {
              e.stopPropagation();
              setPending(true);
              await dispose(alerts, action);
              setPending(false);
            }}
          >
            {DISPOSITION[action]}
          </Button>
        ))}
      {physical && <ClipButton eventId={latest.event_id} title={alertText(latest).title} camera={latest.camera_id} ts={latest.ts} />}
    </div>
  );
}
