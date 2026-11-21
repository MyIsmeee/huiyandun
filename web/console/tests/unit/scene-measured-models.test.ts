import { Quaternion, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import type { SceneFrame } from "../../src/editor/recognition";
import type { Asset } from "../../src/scene/assets";
import { countOf, measuredModels, modelFor, placement } from "../../src/scene/measuredModels";

type SceneObject = SceneFrame["objects"][number];

const square = (x: number, y: number, l = 0.6, w = 0.3): number[][] => [
  [x - l / 2, y - w / 2],
  [x + l / 2, y - w / 2],
  [x + l / 2, y + w / 2],
  [x - l / 2, y + w / 2],
];
const object = (changes: Partial<SceneObject>): SceneObject => ({ class: "appliance", polygon: square(2, 3), height_m: 1.1, ...changes });
const asset = (id: string): Asset => ({ id, category: "appliance", name: id, file: "scene-appliance.glb", footprint: [1, 1], scale: 2, yaw: 0, line: false });

describe("自动场景的电器、箱包与卫浴", () => {
  it("按细分类别选模型：显示器、电视、冰箱按高矮、台灯按高矮、纸箱与卫浴", () => {
    expect(modelFor(object({ kind: "monitor", base_m: 0.75 }))).toBe("monitor");
    expect(modelFor(object({ kind: "computer" }))).toBe("monitor");
    expect(modelFor(object({ kind: "television" }))).toBe("tv");
    expect(modelFor(object({ kind: "refrigerator", height_m: 1.8 }))).toBe("fridge");
    expect(modelFor(object({ kind: "refrigerator", height_m: 0.9 }))).toBe("fridge-small");
    expect(modelFor(object({ kind: "lamp", height_m: 1.2, base_m: 0.75 }))).toBe("lamp-table"); // 桌上 0.45 m 高
    expect(modelFor(object({ kind: "lamp", height_m: 1.6 }))).toBe("lamp-floor");
    expect(modelFor(object({ class: "box", kind: "bag" }))).toBe("box-open");
    expect(modelFor(object({ class: "box" }))).toBe("box");
    expect(modelFor(object({ class: "fixture", kind: "toilet" }))).toBe("toilet");
  });

  it("没有对应模型的（风扇、浴缸）与原有家具类别不摆模型，仍按实测尺寸拼画", () => {
    expect(modelFor(object({ kind: "fan" }))).toBeNull();
    expect(modelFor(object({ class: "fixture", kind: "bathtub" }))).toBe("bathroom-sink"); // 卫浴兜底为洗手台
    expect(modelFor(object({ class: "table", kind: "desk" }))).toBeNull();
    expect(modelFor(object({ class: "chair" }))).toBeNull();
  });

  it("放在底面中心、底部离地 base_m，按目录比例缩放", () => {
    const m = placement(object({ kind: "monitor", base_m: 0.75 }), asset("monitor"), [2, 10]);
    const [position, , scale] = [new Vector3(), new Quaternion(), new Vector3()];
    const turn = new Quaternion();
    m.decompose(position, turn, scale);
    expect(position.toArray().map((v) => Number(v.toFixed(3)))).toEqual([2, 0.75, 3]);
    expect(scale.toArray()).toEqual([2, 2, 2]);
    // 正面（+z）朝向摄像头所在一侧（平面 y 增大的方向）
    const front = new Vector3(0, 0, 1).applyQuaternion(turn);
    expect(front.z).toBeGreaterThan(0.99);
  });

  it("目录中有的才摆放，摆放的物体不再拼画", () => {
    const frame = {
      camera_id: "cam-05",
      surfaces: [],
      walls: [],
      trees: [],
      markings: [],
      objects: [object({ kind: "monitor", base_m: 0.75 }), object({ kind: "fan" }), object({ class: "box" })],
    } as unknown as SceneFrame;
    const { groups, placed } = measuredModels([frame], new Map([["monitor", asset("monitor")]]), { "cam-05": [2, 10] });
    expect([...groups.keys()]).toEqual(["monitor"]);
    expect(placed.size).toBe(1); // box 不在目录中：按方块画
  });

  it("几台显示器连成一簇：按长边排开多台，沿长边等距、都朝向摄像头", () => {
    expect([0.6, 0.8, 1.1, 1.65, 9].map((l) => countOf("monitor", l))).toEqual([1, 1, 2, 3, 6]);
    expect(countOf("tv", 3)).toBe(1); // 电视、冰箱等一簇一件
    const frame = {
      camera_id: "cam-05",
      surfaces: [],
      walls: [],
      trees: [],
      markings: [],
      objects: [object({ kind: "monitor", base_m: 0.75, polygon: square(2, 3, 1.65, 0.3) })],
    } as unknown as SceneFrame;
    const { groups } = measuredModels([frame], new Map([["monitor", asset("monitor")]]), { "cam-05": [2, 10] });
    const at = (groups.get("monitor") ?? []).map((m) => new Vector3().setFromMatrixPosition(m));
    expect(at.map((v) => Number(v.x.toFixed(2)))).toEqual([1.45, 2, 2.55]);
    for (const v of at) expect([v.y, v.z]).toEqual([0.75, 3]);
  });
});
