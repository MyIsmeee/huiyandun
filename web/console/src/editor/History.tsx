import { Redo2, Undo2 } from "lucide-react";
import { useEffect } from "react";
import { create, useStore } from "zustand";
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import type { SceneArea } from "../lib/api";
import type { Device } from "../store/live";
import { areaPlacements } from "./cameras";
import { isDirty, loadDraft, redo, undo, useDraft } from "./draft";

/** 撤销、重做（设计 150 E-6）：Ctrl+Z / Ctrl+Shift+Z（macOS 为 ⌘）；焦点在输入框时保留浏览器自己的撤销 */
export function HistoryButtons() {
  const canUndo = useStore(useDraft.temporal, (s) => s.pastStates.length > 0);
  const canRedo = useStore(useDraft.temporal, (s) => s.futureStates.length > 0);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "z" || (e.target as Element).closest("input, textarea")) return;
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <>
      <Button variant="outline" size="sm" aria-label="撤销" title="撤销（Ctrl+Z）" disabled={!canUndo} onClick={undo}>
        <Undo2 aria-hidden />
      </Button>
      <Button variant="outline" size="sm" aria-label="重做" title="重做（Ctrl+Shift+Z）" disabled={!canRedo} onClick={redo}>
        <Redo2 aria-hidden />
      </Button>
    </>
  );
}

/** 等待确认的离开操作：有值时场景页弹出确认框 */
const useLeave = create<{ action: (() => void) | null }>(() => ({ action: null }));

/**
 * 离开场景页或换区域前过一道确认（设计 150 E-6）：没有未保存的修改时直接执行；有修改时弹出"放弃未保存的修改？"，
 * 放弃后再执行。场景页的返回、换区域，以及顶栏切页、退出都经过这里
 */
export function guardLeave(action: () => void): void {
  if (isDirty(useDraft.getState())) useLeave.setState({ action });
  else action();
}

/** 确认框与关闭、刷新标签页的浏览器提示，随场景页挂载 */
export function DiscardDialog({ area, devices }: { area: SceneArea | null; devices: Device[] }) {
  const dirty = useDraft(isDirty);
  const action = useLeave((s) => s.action);
  useEffect(() => {
    if (!dirty) return;
    const onUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [dirty]);
  if (!action) return null;

  const close = () => useLeave.setState({ action: null });
  const discard = () => {
    if (area) loadDraft(area, areaPlacements(devices, area.id));
    close();
    action();
  };
  return (
    <AlertDialog open onOpenChange={(open) => !open && close()}>
      <AlertDialogContent className="sm:max-w-md">
        <AlertDialogTitle className="text-base font-medium">放弃未保存的修改？</AlertDialogTitle>
        <AlertDialogDescription>当前区域的修改还没有保存，离开后将丢失。</AlertDialogDescription>
        <p className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={close}>
            继续编辑
          </Button>
          <Button size="sm" onClick={discard}>
            放弃修改
          </Button>
        </p>
      </AlertDialogContent>
    </AlertDialog>
  );
}
