import { RotateCw, Trash2 } from "lucide-react";
import { useEffect } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { useCatalog } from "../scene/assets";
import { removeItem, replaceItem, useDraft } from "./draft";
import { overlaps, rotated } from "./placement";

/** 旋转选中的物体 90°；转后超出区域或与其他物体重叠时不转，并说明原因 */
function rotateSelected(catalog: ReturnType<typeof useCatalog>, size: [number, number]) {
  const { items, selected } = useDraft.getState();
  const item = selected === null ? undefined : items[selected];
  const asset = item && catalog.get(item.asset);
  if (selected === null || !item || !asset) return;
  const next = rotated(item, asset, catalog, size);
  if (!next || overlaps(next, items, catalog, selected)) toast.error("旋转后会超出区域或与其他物体重叠");
  else replaceItem(selected, next);
}

/**
 * 选中物体的工具条（设计 150 E-4）：名称、旋转、删除；R 旋转 90°，Delete 删除，Esc 取消选中。
 * 焦点在输入框时不响应快捷键
 */
export function SelectionBar({ width, depth }: { width: number; depth: number }) {
  const catalog = useCatalog();
  const selected = useDraft((s) => s.selected);
  const item = useDraft((s) => (s.selected === null ? undefined : s.items[s.selected]));
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const index = useDraft.getState().selected;
      if (index === null || e.ctrlKey || e.metaKey || (e.target as Element).closest("input, textarea")) return;
      if (e.key === "r" || e.key === "R") rotateSelected(catalog, [width, depth]);
      else if (e.key === "Delete" || e.key === "Backspace") removeItem(index);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [catalog, width, depth]);
  if (selected === null || !item) return null;

  return (
    <div
      role="toolbar"
      aria-label="选中的物体"
      className="absolute top-3 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-lg border bg-card/90 py-1 pr-1 pl-3 text-meta text-muted-foreground backdrop-blur-sm"
    >
      <span className="text-foreground">选中：{catalog.get(item.asset)?.name ?? item.asset}</span>
      <Button variant="ghost" size="sm" onClick={() => rotateSelected(catalog, [width, depth])}>
        <RotateCw aria-hidden />
        旋转 <Kbd>R</Kbd>
      </Button>
      <Button variant="ghost" size="sm" onClick={() => removeItem(selected)}>
        <Trash2 aria-hidden />
        删除 <Kbd>Delete</Kbd>
      </Button>
    </div>
  );
}
