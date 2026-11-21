import { useEffect } from "react";
import { toast } from "sonner";
import { temporal } from "zundo";
import { create } from "zustand";
import type { SceneArea } from "../lib/api";
import type { SceneItem } from "../scene/assets";
import type { CameraPlacement } from "./cameras";

/** 场景页正在编辑的区域草稿（设计 150 §6）：修改只在本页，保存为整体 PUT（E-7） */
interface Draft {
  areaId: string | null;
  /** 载入时的 updated_at，保存时原样带回，防止覆盖他人的修改 */
  updatedAt: string;
  /** 载入或上次保存时的物体，与 items 不同即有未保存的修改 */
  saved: SceneItem[];
  items: SceneItem[];
  /** 区域内摄像头的位置与朝向（E-5）；savedCameras 为载入或上次保存时的 */
  savedCameras: CameraPlacement[];
  cameras: CameraPlacement[];
  /** 放置中的资产编号（E-2），或 camera:<摄像头编号>（E-5）；null 为未选 */
  tool: string | null;
  /** 选中的物体在 items 中的下标（E-4） */
  selected: number | null;
  /** 从画面生成、尚未接受的初稿（设计 150 §7）：只在本页叠加预览，不随保存提交，不记入撤销历史 */
  pending: SceneItem[];
  /** 载入代次：每次载入（换区域、放弃修改、重新载入）加一。保存请求返回时据此判断草稿是否还是发起时那一份 */
  generation: number;
}

/** 区域物体数上限（契约 SceneAreaUpdate.items 的 maxItems） */
export const MAX_ITEMS = 2000;
export const tooMany = (count: number) => count > MAX_ITEMS;
const TOO_MANY = `区域最多 ${MAX_ITEMS} 件物体`;

/** 撤销、重做的步数上限（设计 150 E-6） */
export const UNDO_LIMIT = 50;

const CAMERA_TOOL = "camera:";
/** 放置中的摄像头编号；不是摄像头时为 null */
export const cameraTool = (tool: string | null) => (tool?.startsWith(CAMERA_TOOL) ? tool.slice(CAMERA_TOOL.length) : null);

/** 撤销、重做只记录物体与摄像头位置的变化（zundo，MIT），选模型、载入与保存不算一步 */
export const useDraft = create<Draft>()(
  temporal((): Draft => ({ areaId: null, updatedAt: "", saved: [], items: [], savedCameras: [], cameras: [], tool: null, selected: null, pending: [], generation: 0 }), {
    partialize: (s): Pick<Draft, "items" | "cameras"> => ({ items: s.items, cameras: s.cameras }),
    equality: (a, b) => a.items === b.items && a.cameras === b.cameras,
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

/** 载入区域与其中摄像头的位置：丢弃未保存的修改与撤销历史，退出放置 */
export function loadDraft(area: SceneArea, cameras: CameraPlacement[]): void {
  const generation = useDraft.getState().generation + 1;
  untracked({ areaId: area.id, updatedAt: area.updated_at, saved: area.items, items: area.items, savedCameras: cameras, cameras, tool: null, selected: null, pending: [], generation });
  useDraft.temporal.getState().clear();
}

/** 保存发起时的草稿：区域与载入代次 */
export type DraftToken = Pick<Draft, "areaId" | "generation">;
export const draftToken = (): DraftToken => {
  const { areaId, generation } = useDraft.getState();
  return { areaId, generation };
};

/**
 * 保存成功：已保存的基准与 updated_at 取服务端返回，草稿本身不动——保存请求进行中又做的修改仍是未保存的修改；
 * 撤销历史保留，撤销后又成为未保存的修改。
 * 保存进行中换了区域或放弃修改重新载入（token 不再匹配）时不写：否则另一份草稿拿到不属于它的基准与 updated_at，
 * 显示为有修改且保存必然 409，或旧内容被当作已保存、再保存时覆盖刚保存的内容。返回是否写入
 */
export function savedDraft(area: SceneArea, cameras: CameraPlacement[], token: DraftToken): boolean {
  const { areaId, generation } = useDraft.getState();
  if (areaId !== token.areaId || generation !== token.generation || areaId !== area.id) return false;
  untracked({ updatedAt: area.updated_at, saved: area.items, savedCameras: cameras });
  return true;
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

export const placeItem = (item: SceneItem) => {
  if (tooMany(useDraft.getState().items.length + 1)) toast.error(TOO_MANY, { id: "scene-too-many" });
  else useDraft.setState((s) => ({ items: [...s.items, item] }));
};
/** 选模型进入放置时取消选中，二者不同时进行 */
export const selectTool = (tool: string | null) => useDraft.setState({ tool, selected: null });
export const selectItem = (selected: number | null) => useDraft.setState({ selected });
/** 移动或旋转选中的物体：替换为新的放置点，算一步 */
export const replaceItem = (index: number, item: SceneItem) =>
  useDraft.setState((s) => ({ items: s.items.map((it, i) => (i === index ? item : it)) }));
export const removeItem = (index: number) =>
  useDraft.setState((s) => ({ items: s.items.filter((_, i) => i !== index), selected: null }));
/** 放入或重新放置摄像头，退出放置；放回原处（位置与朝向不变）不算一步，不清掉可重做的步骤 */
export const placeCamera = (placement: CameraPlacement) => {
  const current = useDraft.getState().cameras.find((c) => c.id === placement.id);
  if (current && current.x === placement.x && current.y === placement.y && current.yaw_deg === placement.yaw_deg) untracked({ tool: null });
  else useDraft.setState((s) => ({ cameras: [...s.cameras.filter((c) => c.id !== placement.id), placement], tool: null }));
};
/** 移出区域：保存后该摄像头不属于任何区域，3D 中不出现 */
export const removeCamera = (id: string) => useDraft.setState((s) => ({ cameras: s.cameras.filter((c) => c.id !== id) }));
export const placingCamera = (id: string) => selectTool(`${CAMERA_TOOL}${id}`);

/** 叠加显示生成的初稿：退出放置、取消选中，替换上一次未接受的初稿 */
export const proposeDraft = (pending: SceneItem[]) => useDraft.setState({ pending, tool: null, selected: null });
/** 接受初稿：accepted（已去掉与现有物体重叠的）并入物体，算一步；之后与手动放置的物体一样可删改，保存时提交 */
export const acceptDraft = (accepted: SceneItem[]): boolean => {
  const { items } = useDraft.getState();
  if (tooMany(items.length + accepted.length)) {
    toast.error(TOO_MANY, { description: `已有 ${items.length} 件，初稿 ${accepted.length} 件；可先删去部分物体再接受` });
    return false;
  }
  // 全部与已有物体重叠时没有可并入的：只收起初稿，不记一步空操作（否则清掉可重做的步骤）
  if (accepted.length === 0) untracked({ pending: [] });
  else useDraft.setState((s) => ({ items: [...s.items, ...accepted], pending: [] }));
  return true;
};
export const discardDraft = () => useDraft.setState({ pending: [] });

export const sameCameras = (a: CameraPlacement[], b: CameraPlacement[]) =>
  JSON.stringify([...a].sort((x, y) => x.id.localeCompare(y.id))) === JSON.stringify([...b].sort((x, y) => x.id.localeCompare(y.id)));
export const isDirty = (s: Draft) => JSON.stringify(s.items) !== JSON.stringify(s.saved) || !sameCameras(s.cameras, s.savedCameras);

/** 区域比草稿载入时更新：他人保存过。本页保存后草稿的 updated_at 先于站点推送更新，此时站点里的区域较旧，不算 */
const newer = (area: SceneArea, draft: Draft) => Date.parse(area.updated_at) > Date.parse(draft.updatedAt);

/**
 * 草稿跟随区域（设计 150 E-7）：换区域时载入；他人保存了同一区域（updated_at 变化）而本页没有未保存的修改时，
 * 换成最新内容；有未保存的修改时保留，保存时由服务端以 409 拒绝——之后撤销回无修改时同样换成最新内容。
 * 未接受的初稿按旧场景与摄像头位置生成，随之丢弃并提示。
 * registered 为登记表中的全部摄像头编号：草稿里已被他人删除的摄像头从草稿与撤销历史中去掉，否则保存永远 400
 */
export function useDraftSync(area: SceneArea, cameras: CameraPlacement[], registered: string[]): void {
  const key = JSON.stringify(cameras);
  const ids = registered.join(",");
  const dirty = useDraft(isDirty);
  useEffect(() => {
    const draft = useDraft.getState();
    const switched = draft.areaId !== area.id;
    if (!switched && (!newer(area, draft) || dirty)) return;
    if (!switched && draft.pending.length > 0) toast.warning("区域已被修改并重新载入，未接受的初稿已丢弃，可重新生成");
    loadDraft(area, JSON.parse(key));
  }, [area, key, dirty]);
  useEffect(() => {
    const exists = new Set(ids.split(","));
    const draft = useDraft.getState();
    if (draft.areaId !== area.id) return;
    const gone = draft.cameras.filter((c) => !exists.has(c.id)).map((c) => c.id);
    if (gone.length === 0) return;
    const keep = (list: CameraPlacement[] | undefined) => list?.filter((c) => exists.has(c.id));
    untracked({ cameras: keep(draft.cameras) ?? [], savedCameras: keep(draft.savedCameras) ?? [], tool: cameraTool(draft.tool) && !exists.has(cameraTool(draft.tool) ?? "") ? null : draft.tool });
    useDraft.temporal.setState((t) => ({
      pastStates: t.pastStates.map((p) => ({ ...p, cameras: keep(p.cameras) })),
      futureStates: t.futureStates.map((p) => ({ ...p, cameras: keep(p.cameras) })),
    }));
    toast.warning(`摄像头 ${gone.join("、")} 已被删除，已从本页草稿中移除`);
  }, [area.id, ids]);
}
