import { Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { ApiError, api } from "../../lib/api";
import { canContain, useSession } from "../../store/session";

/** 删除只是不再列出：原始记录、存证、处置与审计照常保留 */
export const KEPT = "原始记录、存证与审计日志照常保留";

/** 删除告警与关联事件：结果经 cleared 频道推送，各控制台据此移除；失败时提示原因 */
export async function removeAlerts(eventIds: string[], incidentIds: string[]): Promise<boolean> {
  if (eventIds.length === 0 && incidentIds.length === 0) return true;
  try {
    await api.clearAlerts(eventIds, incidentIds);
    return true;
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : "删除未提交，请检查网络后重试");
    return false;
  }
}

/** operator 及以上可删除（C-FE-07） */
export const useCanClear = () => canContain(useSession((s) => s.role));

/** 一行的删除按钮：合并行一次删掉整组 */
export function DeleteButton(props: { label: string; eventIds: string[]; incidentIds?: string[] }) {
  const { label, eventIds, incidentIds = [] } = props;
  const [pending, setPending] = useState(false);
  if (!useCanClear()) return null;
  return (
    <button
      type="button"
      aria-label={label}
      title={`${label}（${KEPT}）`}
      disabled={pending}
      onClick={async () => {
        setPending(true);
        if (!(await removeAlerts(eventIds, incidentIds))) setPending(false);
      }}
      className="mt-1.5 mr-2 grid size-7 shrink-0 place-items-center rounded-md text-subtle-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-50"
    >
      <Trash2 aria-hidden className="size-4" />
    </button>
  );
}

/** 告警栏"清空"：确认后删除当前筛选下列出的全部告警与关联事件 */
export function ClearAll(props: { eventIds: string[]; incidentIds: string[]; count: number }) {
  const { eventIds, incidentIds, count } = props;
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  if (!useCanClear()) return null;
  return (
    <>
      <Button variant="ghost" size="sm" disabled={count === 0} onClick={() => setConfirming(true)} className="h-7 px-2 text-meta text-muted-foreground">
        <Trash2 aria-hidden />
        清空
      </Button>
      {confirming && (
        <AlertDialog open onOpenChange={(open) => !open && setConfirming(false)}>
          <AlertDialogContent className="sm:max-w-md">
            <AlertDialogTitle className="text-base font-medium">清空告警</AlertDialogTitle>
            <AlertDialogDescription>
              删除当前列出的 {count} 条告警？所有控制台的告警栏都不再显示它们；{KEPT}。
            </AlertDialogDescription>
            <p className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setConfirming(false)}>
                取消
              </Button>
              <Button
                size="sm"
                disabled={pending}
                onClick={async () => {
                  setPending(true);
                  const ok = await removeAlerts(eventIds, incidentIds);
                  setPending(false);
                  if (ok) setConfirming(false);
                }}
              >
                {pending ? "删除中…" : "确认清空"}
              </Button>
            </p>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </>
  );
}
