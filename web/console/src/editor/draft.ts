import { useEffect } from "react";
import { temporal } from "zundo";
import { create } from "zustand";
import type { SceneArea } from "../lib/api";
import type { SceneItem } from "../scene/assets";

/** 场景页正在编辑的区域草稿（设计 150 §6）：修改只在本页，保存为整体 PUT（E-7） */
interface Draft {
  areaId: string | null;
  /** 载入时的 updated_at，保存时原样带回，防止覆盖他人的修改 */
  updatedAt: string;
  /** 载入或上次保存时的物体，与 items 不同即有未保存的修改 */
  saved: SceneItem[];
  items: SceneItem[];
  /** 放置中的资产编号（E-2），null 为未选模型 */
  tool: string | null;
  /** 选中的物体在 items 中的下标（E-4） */
  selected: number | null;
}

/** 撤销、重做的步数上限（设计 150 E-6） */
export const UNDO_LIMIT = 50;

/** 撤销、重做只记录物体的变化（zundo，MIT），选模型、载入与保存不算一步 */
export const useDraft = create<Draft>()(
  temporal((): Draft => ({ areaId: null, updatedAt: "", saved: [], items: [], tool: null, selected: null }), {
    partialize: (s): Pick<Draft, "items"> => ({ items: s.items }),
    equality: (a, b) => a.items === b.items,
    limit: UNDO_LIMIT,
  }),
);

/** 不记入撤销历史地改草稿 */
function untracked(change: Partial<Draft>) {
  const history = useDraft.temporal.getState();
  history.pause();
  useDraft.setState(change);
  history.resume();
}

/** 载入区域：丢弃未保存的修改与撤销历史，退出放置 */
export function loadDraft(area: SceneArea): void {
  untracked({ areaId: area.id, updatedAt: area.updated_at, saved: area.items, items: area.items, tool: null, selected: null });
  useDraft.temporal.getState().clear();
}

/** 保存成功：以服务端返回为准；撤销历史保留，撤销后又成为未保存的修改 */
export function savedDraft(area: SceneArea): void {
  untracked({ updatedAt: area.updated_at, saved: area.items, items: area.items });
}

// 撤销、重做后下标可能已不指向原物体，取消选中
export const undo = () => {
  useDraft.temporal.getState().undo();
  useDraft.setState({ selected: null });
};
export const redo = () => {
  useDraft.temporal.getState().redo();
  useDraft.setState({ selected: null });
};

export const placeItem = (item: SceneItem) => useDraft.setState((s) => ({ items: [...s.items, item] }));
/** 选模型进入放置时取消选中，二者不同时进行 */
export const selectTool = (tool: string | null) => useDraft.setState({ tool, selected: null });
export const selectItem = (selected: number | null) => useDraft.setState({ selected });
/** 移动或旋转选中的物体：替换为新的放置点，算一步 */
export const replaceItem = (index: number, item: SceneItem) =>
  useDraft.setState((s) => ({ items: s.items.map((it, i) => (i === index ? item : it)) }));
export const removeItem = (index: number) =>
  useDraft.setState((s) => ({ items: s.items.filter((_, i) => i !== index), selected: null }));

export const isDirty = (s: Draft) => JSON.stringify(s.items) !== JSON.stringify(s.saved);

/**
 * 草稿跟随区域（设计 150 E-7）：换区域时载入；他人保存了同一区域（updated_at 变化）而本页没有未保存的修改时，
 * 换成最新内容；有未保存的修改时保留，保存时由服务端以 409 拒绝
 */
export function useDraftSync(area: SceneArea): void {
  useEffect(() => {
    const draft = useDraft.getState();
    if (draft.areaId !== area.id || (draft.updatedAt !== area.updated_at && !isDirty(draft))) loadDraft(area);
  }, [area]);
}
