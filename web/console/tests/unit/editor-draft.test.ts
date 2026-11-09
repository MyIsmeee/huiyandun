import { beforeEach, describe, expect, it } from "vitest";
import { isDirty, loadDraft, placeItem, redo, removeItem, replaceItem, savedDraft, selectItem, selectTool, UNDO_LIMIT, undo, useDraft } from "../../src/editor/draft";

const AREA = { id: "area-01", name: "默认区域", width_m: 40, depth_m: 24, items: [], updated_at: "2026-11-09T00:00:00Z" };
const desk = (x: number) => ({ asset: "desk", x, y: 1.5, rot: 0 as const, len: null });
const count = () => useDraft.getState().items.length;
const history = () => useDraft.temporal.getState();

describe("区域草稿的撤销与重做（设计 150 E-6）", () => {
  beforeEach(() => loadDraft(AREA));

  it("每次放置为一步，可撤销、重做；选模型不算一步", () => {
    selectTool("desk");
    placeItem(desk(1));
    placeItem(desk(3));
    selectTool(null);
    expect(history().pastStates).toHaveLength(2);

    undo();
    expect(count()).toBe(1);
    redo();
    expect(count()).toBe(2);
  });

  it(`最多保留 ${UNDO_LIMIT} 步`, () => {
    for (let i = 0; i < UNDO_LIMIT + 10; i += 1) placeItem(desk(i));
    history().undo(UNDO_LIMIT + 10);
    expect(count()).toBe(10);
  });

  it("撤销回到已保存的内容即没有未保存的修改", () => {
    placeItem(desk(1));
    expect(isDirty(useDraft.getState())).toBe(true);
    undo();
    expect(isDirty(useDraft.getState())).toBe(false);
  });

  it("载入区域清空历史；保存不算一步，保存后撤销又成为未保存的修改", () => {
    placeItem(desk(1));
    savedDraft({ ...AREA, items: [desk(1)], updated_at: "2026-11-09T01:00:00Z" });
    expect(history().pastStates).toHaveLength(1);
    expect(isDirty(useDraft.getState())).toBe(false);
    undo();
    expect(isDirty(useDraft.getState())).toBe(true);

    loadDraft(AREA);
    expect(history().pastStates).toHaveLength(0);
    expect(history().futureStates).toHaveLength(0);
  });

  it("移动、删除选中的物体各为一步；撤销后取消选中，选模型放置时也取消选中", () => {
    placeItem(desk(1));
    selectItem(0);
    replaceItem(0, desk(5));
    removeItem(0);
    expect(count()).toBe(0);
    expect(useDraft.getState().selected).toBeNull();
    undo();
    expect(useDraft.getState().items).toEqual([desk(5)]);
    selectItem(0);
    undo();
    expect(useDraft.getState().items).toEqual([desk(1)]);
    expect(useDraft.getState().selected).toBeNull();
    selectItem(0);
    selectTool("tree");
    expect(useDraft.getState().selected).toBeNull();
  });
});
