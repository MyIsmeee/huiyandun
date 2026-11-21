import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { areaPlacements, normalizedYaw } from "../../src/editor/cameras";
import type { SceneArea } from "../../src/lib/api";
import { acceptDraft, cameraTool, discardDraft, draftToken, isDirty, loadDraft, MAX_ITEMS, placeCamera, placeItem, placingCamera, proposeDraft, redo, removeCamera, removeItem, replaceItem, savedDraft, selectItem, selectTool, UNDO_LIMIT, undo, useDraft, useDraftSync } from "../../src/editor/draft";

const AREA: SceneArea = { id: "area-01", name: "默认区域", width_m: 40, depth_m: 24, items: [], updated_at: "2026-11-09T00:00:00Z" };
const desk = (x: number) => ({ asset: "desk", x, y: 1.5, rot: 0 as const, len: null });
const count = () => useDraft.getState().items.length;
const history = () => useDraft.temporal.getState();

describe("区域草稿的撤销与重做（设计 150 E-6）", () => {
  beforeEach(() => loadDraft(AREA, []));

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
    savedDraft({ ...AREA, items: [desk(1)], updated_at: "2026-11-09T01:00:00Z" }, [], draftToken());
    expect(history().pastStates).toHaveLength(1);
    expect(isDirty(useDraft.getState())).toBe(false);
    undo();
    expect(isDirty(useDraft.getState())).toBe(true);

    loadDraft(AREA, []);
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

  it("保存进行中又做的修改在保存成功后仍是未保存的修改", () => {
    placeItem(desk(1));
    const sent = useDraft.getState().items;
    placeItem(desk(3)); // 请求发出后、响应到达前
    savedDraft({ ...AREA, items: sent, updated_at: "2026-11-09T01:00:00Z" }, [], draftToken());
    expect(count()).toBe(2);
    expect(isDirty(useDraft.getState())).toBe(true);
  });

  it("摄像头放入、移出各为一步；顺序不同不算修改；放下后退出放置", () => {
    const cam = { id: "cam-01", x: 2, y: 2, yaw_deg: 45 };
    loadDraft(AREA, [cam, { ...cam, id: "cam-02" }]);
    useDraft.setState((s) => ({ cameras: [...s.cameras].reverse() }));
    expect(isDirty(useDraft.getState())).toBe(false);

    placingCamera("cam-03");
    expect(cameraTool(useDraft.getState().tool)).toBe("cam-03");
    placeCamera({ ...cam, id: "cam-03" });
    expect(useDraft.getState().tool).toBeNull();
    removeCamera("cam-01");
    expect(useDraft.getState().cameras.map((c) => c.id)).toEqual(["cam-02", "cam-03"]);
    undo();
    undo();
    expect(isDirty(useDraft.getState())).toBe(false);
  });
});

describe("区域内摄像头的放置点（设计 150 E-5）", () => {
  it("取登记表中 area_id 为该区域的摄像头，朝向归一到 [0, 360)", () => {
    const pose = { x: 3, y: 4, height_m: 3, yaw_deg: -90, pitch_deg: -30, hfov_deg: 90, range_m: 6 };
    const device = (id: string, area_id: string | null) => ({ id, camera: { area_id, pose } }) as never;
    expect(areaPlacements([device("cam-01", "area-01"), device("cam-02", null)], "area-01")).toEqual([{ id: "cam-01", x: 3, y: 4, yaw_deg: 270 }]);
    expect(normalizedYaw(720)).toBe(0);
  });
});

describe("从画面生成的初稿（设计 150 §7）", () => {
  beforeEach(() => loadDraft(AREA, []));

  it("预览不算修改、不进撤销历史、不随保存提交", () => {
    proposeDraft([desk(1), desk(3)]);

    expect(useDraft.getState().items).toEqual([]);
    expect(isDirty(useDraft.getState())).toBe(false);
    expect(history().pastStates).toHaveLength(0);
  });

  it("全部接受并入物体，算一步，可撤销", () => {
    proposeDraft([desk(1), desk(3)]);
    acceptDraft([desk(1)]);

    expect(useDraft.getState()).toMatchObject({ items: [desk(1)], pending: [] });
    expect(isDirty(useDraft.getState())).toBe(true);
    undo();
    expect(count()).toBe(0);
  });

  it("放弃或换区域都丢弃初稿", () => {
    proposeDraft([desk(1)]);
    discardDraft();
    expect(useDraft.getState().pending).toEqual([]);

    proposeDraft([desk(1)]);
    loadDraft({ ...AREA, id: "area-02" }, []);
    expect(useDraft.getState().pending).toEqual([]);
  });
});

describe("保存响应与草稿的对应", () => {
  beforeEach(() => loadDraft(AREA, []));

  it("保存进行中放弃修改重新载入：迟到的响应不写入，旧内容不会被当作已保存", () => {
    placeItem(desk(1));
    const token = draftToken();
    loadDraft(AREA, []); // 放弃修改
    expect(savedDraft({ ...AREA, items: [desk(1)], updated_at: "2026-11-09T01:00:00Z" }, [], token)).toBe(false);
    expect(useDraft.getState()).toMatchObject({ updatedAt: AREA.updated_at, saved: [] });
  });

  it("保存进行中换了区域：响应不写进另一个区域的草稿", () => {
    placeItem(desk(1));
    const token = draftToken();
    loadDraft({ ...AREA, id: "area-02" }, []);
    expect(savedDraft({ ...AREA, items: [desk(1)], updated_at: "2026-11-09T01:00:00Z" }, [], token)).toBe(false);
    expect(isDirty(useDraft.getState())).toBe(false);
  });
});

describe("无变化的操作不记入撤销历史", () => {
  beforeEach(() => loadDraft(AREA, [{ id: "cam-01", x: 2, y: 2, yaw_deg: 45 }]));

  it("全部重叠、没有可接受的初稿：只收起初稿，可重做的步骤保留", () => {
    placeItem(desk(1));
    undo();
    proposeDraft([desk(1)]);
    acceptDraft([]);
    expect(useDraft.getState().pending).toEqual([]);
    expect(history().futureStates).toHaveLength(1);
  });

  it("摄像头放回原位不算一步", () => {
    placingCamera("cam-01");
    placeCamera({ id: "cam-01", x: 2, y: 2, yaw_deg: 45 });
    expect(history().pastStates).toHaveLength(0);
    expect(useDraft.getState().tool).toBeNull();
  });

  it(`物体数超过 ${MAX_ITEMS} 时不放置、不接受`, () => {
    useDraft.setState({ items: Array.from({ length: MAX_ITEMS }, (_, i) => desk(i)) });
    placeItem(desk(1));
    expect(count()).toBe(MAX_ITEMS);
    expect(acceptDraft([desk(2)])).toBe(false);
    expect(count()).toBe(MAX_ITEMS);
  });
});

describe("草稿跟随区域（设计 150 E-7）", () => {
  const cam = { id: "cam-01", x: 2, y: 2, yaw_deg: 45 };
  beforeEach(() => loadDraft(AREA, []));

  it("有修改时他人保存了区域，撤销回无修改后换成最新内容", () => {
    const { rerender } = renderHook(({ area }) => useDraftSync(area, [], ["cam-01"]), { initialProps: { area: AREA } });
    placeItem(desk(1));
    const theirs = { ...AREA, items: [desk(7)], updated_at: "2026-11-09T02:00:00Z" };
    rerender({ area: theirs });
    expect(useDraft.getState().items).toEqual([desk(1)]); // 有修改时保留
    undo();
    rerender({ area: theirs });
    expect(useDraft.getState()).toMatchObject({ items: [desk(7)], updatedAt: theirs.updated_at });
  });

  it("本页保存后站点推送尚未到达：不按站点里较旧的区域重新载入", () => {
    const { rerender } = renderHook(({ area }) => useDraftSync(area, [], []), { initialProps: { area: AREA } });
    placeItem(desk(1));
    savedDraft({ ...AREA, items: [desk(1)], updated_at: "2026-11-09T01:00:00Z" }, [], draftToken());
    rerender({ area: AREA });
    expect(useDraft.getState().items).toEqual([desk(1)]);
  });

  it("草稿里放入的摄像头被他人删除：从草稿与撤销历史中去掉", () => {
    const { rerender } = renderHook(({ ids }) => useDraftSync(AREA, [], ids), { initialProps: { ids: ["cam-01"] } });
    placeCamera(cam);
    placeCamera({ ...cam, x: 5 });
    rerender({ ids: [] });
    expect(useDraft.getState().cameras).toEqual([]);
    undo(); // 历史中放入时的那一步同样已去掉
    expect(useDraft.getState().cameras).toEqual([]);
  });
});
