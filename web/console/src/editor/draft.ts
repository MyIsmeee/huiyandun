import { useEffect } from "react";
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
}

export const useDraft = create<Draft>()(() => ({ areaId: null, updatedAt: "", saved: [], items: [], tool: null }));

/** 载入区域：丢弃未保存的修改，退出放置 */
export function loadDraft(area: SceneArea): void {
  useDraft.setState({ areaId: area.id, updatedAt: area.updated_at, saved: area.items, items: area.items, tool: null });
}

export const placeItem = (item: SceneItem) => useDraft.setState((s) => ({ items: [...s.items, item] }));
export const selectTool = (tool: string | null) => useDraft.setState({ tool });

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
