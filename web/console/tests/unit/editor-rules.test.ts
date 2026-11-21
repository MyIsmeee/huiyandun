import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDraft } from "../../src/editor/draft";
import {
  addPoint,
  type CameraRule,
  cycleDirection,
  directionArrows,
  finishDrawing,
  MAX_POINTS,
  polygonProblem,
  removeRule,
  selectRuleCamera,
  startDrawing,
  toggleRules,
  undoPoint,
  useRules,
} from "../../src/editor/rules";
import { api } from "../../src/lib/api";

const LINE: CameraRule = { id: "line-1", name: "大门", type: "line_crossing", points: [[0, 0], [0, 4]], direction: "any", classes: ["person"], min_duration_s: 1 };

/** PATCH 原样回显规则 */
function echo() {
  return vi.spyOn(api, "updateCamera").mockImplementation(async (_id, body) => ({ rules: body.rules ?? [] }) as never);
}

beforeEach(() => useRules.setState({ open: true, cameraId: "cam-03", rules: [LINE], loading: false, failed: false, drawing: null, saving: false }));
afterEach(() => vi.restoreAllMocks());

describe("轨迹规则编辑", () => {
  it("逐点绘制区域：顶点吸附 0.1 m，可撤销一点；不足 3 个顶点不能完成", async () => {
    const update = echo();
    startDrawing("intrusion");
    addPoint(1.04, 2.06);
    addPoint(5, 2);
    expect(await finishDrawing("库区")).toBe(false);
    addPoint(9, 9);
    undoPoint();
    addPoint(5, 6.01);

    expect(await finishDrawing("库区")).toBe(true);

    const saved = update.mock.calls[0]?.[1].rules ?? [];
    expect(saved.map((r) => r.id)).toEqual(["line-1", "zone-1"]);
    expect(saved[1]).toMatchObject({ name: "库区", type: "intrusion", points: [[1, 2.1], [5, 2], [5, 6]] });
    expect(useRules.getState().drawing).toBeNull();
  });

  it("越线方向依次切换双向、正向、反向；删除后整体保存", async () => {
    const update = echo();
    await cycleDirection("line-1");
    expect(useRules.getState().rules[0]?.direction).toBe("forward");
    await cycleDirection("line-1");
    expect(useRules.getState().rules[0]?.direction).toBe("backward");

    await removeRule("line-1");

    expect(update).toHaveBeenLastCalledWith("cam-03", { rules: [] });
  });

  it("保存失败时保留已画的顶点", async () => {
    vi.spyOn(api, "updateCamera").mockRejectedValue(new Error("网络错误"));
    startDrawing("line_crossing");
    addPoint(0, 0);
    addPoint(3, 0);

    expect(await finishDrawing("")).toBe(false);
    expect(useRules.getState().drawing?.points).toHaveLength(2);
  });

  it("正向箭头指向沿线前进方向的右侧（左侧穿到右侧），与视觉引擎约定一致", () => {
    // 自 (0,0) 指向 (0,4)：右侧为平面 +x
    expect(directionArrows([[0, 0], [0, 4]], 1)).toEqual([{ from: [0, 2], to: [1, 2] }]);
  });

  it("规则读取失败：不能新建、删除、切换方向（列表不是实际规则，保存会整体覆盖），重试成功后恢复", async () => {
    const update = echo();
    vi.spyOn(api, "listCameras").mockRejectedValueOnce(new Error("超时")).mockResolvedValueOnce({ items: [{ id: "cam-03", rules: [LINE] }] } as never);
    await selectRuleCamera("cam-03");
    expect(useRules.getState()).toMatchObject({ failed: true, rules: [] });

    startDrawing("intrusion");
    expect(useRules.getState().drawing).toBeNull();
    expect(await removeRule("line-1")).toBe(false);
    expect(update).not.toHaveBeenCalled();

    await selectRuleCamera("cam-03");
    expect(useRules.getState()).toMatchObject({ failed: false, rules: [LINE] });
  });

  it("面板重新打开时重读所选摄像头的规则", async () => {
    const list = vi.spyOn(api, "listCameras").mockResolvedValue({ items: [{ id: "cam-03", rules: [] }] } as never);
    toggleRules(false);
    toggleRules(true);
    await vi.waitFor(() => expect(useRules.getState().loading).toBe(false));
    expect(list).toHaveBeenCalledTimes(1);
    expect(useRules.getState().rules).toEqual([]);
  });

  it("保存进行中换了摄像头：返回的规则不写进新摄像头的列表", async () => {
    let resolve: (v: unknown) => void = () => undefined;
    vi.spyOn(api, "updateCamera").mockImplementation(() => new Promise((r) => (resolve = r)) as never);
    vi.spyOn(api, "listCameras").mockResolvedValue({ items: [{ id: "cam-04", rules: [] }] } as never);
    const saving = removeRule("line-1");
    await selectRuleCamera("cam-04");
    resolve({ rules: [{ ...LINE, id: "line-9" }] });
    await saving;
    expect(useRules.getState()).toMatchObject({ cameraId: "cam-04", rules: [], saving: false });
  });

  it("与上一点重合的顶点不加；顶点数到上限后不再加", () => {
    startDrawing("line_crossing");
    addPoint(1, 1);
    addPoint(1.02, 1.01);
    expect(useRules.getState().drawing?.points).toHaveLength(1);
    for (let i = 0; i < MAX_POINTS + 5; i += 1) addPoint(i + 2, 0);
    expect(useRules.getState().drawing?.points).toHaveLength(MAX_POINTS);
  });

  it("开始绘制时退出模型放置、取消选中；绘制中选了模型即取消绘制", () => {
    useDraft.setState({ tool: null, selected: 2 });
    startDrawing("intrusion");
    expect(useDraft.getState().selected).toBeNull();
    useDraft.setState({ tool: "desk" });
    expect(useRules.getState().drawing).toBeNull();
    useDraft.setState({ tool: null });
  });

  it("区域：共线或边交叉的不能完成", async () => {
    expect(polygonProblem([[0, 0], [1, 0], [2, 0]])).toMatch("直线");
    expect(polygonProblem([[0, 0], [2, 2], [2, 0], [0, 2]])).toMatch("交叉");
    expect(polygonProblem([[0, 0], [4, 0], [4, 4], [0, 4]])).toBeNull();
    const update = echo();
    startDrawing("intrusion");
    for (const [x, y] of [[0, 0], [2, 2], [2, 0], [0, 2]] as const) addPoint(x, y);
    expect(await finishDrawing("")).toBe(false);
    expect(update).not.toHaveBeenCalled();
  });
});
