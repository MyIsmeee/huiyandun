import { Redo2, Undo2 } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { useStore } from "zustand";
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

/**
 * 有未保存的修改时，返回或换区域前先确认（设计 150 E-6）；关闭、刷新标签页由浏览器提示。
 * guard(action)：没有修改时直接执行；有修改时弹出确认，放弃修改后再执行
 */
export function useDiscardGuard(
  area: SceneArea | null,
  devices: Device[],
): { guard: (action: () => void) => void; dialog: ReactNode } {
  const dirty = useDraft(isDirty);
  const [pending, setPending] = useState<{ action: () => void } | null>(null);
  useEffect(() => {
    if (!dirty) return;
    const onUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [dirty]);

  const guard = (action: () => void) => (dirty ? setPending({ action }) : action());
  const discard = () => {
    if (area) loadDraft(area, areaPlacements(devices, area.id));
    pending?.action();
    setPending(null);
  };
  const dialog = pending && (
    <AlertDialog open onOpenChange={(open) => !open && setPending(null)}>
      <AlertDialogContent className="sm:max-w-md">
        <AlertDialogTitle className="text-base font-medium">放弃未保存的修改？</AlertDialogTitle>
        <AlertDialogDescription>当前区域的修改还没有保存，离开后将丢失。</AlertDialogDescription>
        <p className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => setPending(null)}>
            继续编辑
          </Button>
          <Button size="sm" onClick={discard}>
            放弃修改
          </Button>
        </p>
      </AlertDialogContent>
    </AlertDialog>
  );
  return { guard, dialog };
}
