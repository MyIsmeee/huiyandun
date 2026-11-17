import { Quaternion, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import type { SceneFrame } from "../../src/editor/recognition";
import type { Asset, SceneItem } from "../../src/scene/assets";
import { type Anchor, chairMatrix, HOLD_MS, RELEASE_MS, type Seat, seatsFromFrames, seatsFromItems, settle } from "../../src/scene/seating";

const CHAIR: Seat = [2, 3];

/** 逐帧推进：frames 为（毫秒时刻, 是否坐姿, 实测髋部） */
function run(frames: [number, boolean, Seat][], seats: Seat[] = [CHAIR]): (Anchor | undefined)[] {
  let anchor: Anchor | undefined;
  return frames.map(([now, seated, hip]) => (anchor = settle(anchor, seated, hip, seats, now)));
}

describe("落座绑定", () => {
  it("坐下时髋部吸附到 1 m 内最近的椅子，之后实测抖动不改变位置", () => {
    const anchors = run([
      [0, true, [2.4, 3.3]],
      [200, true, [1.6, 2.6]], // 脚点推算来回跳动 0.5 m 以上
      [400, true, [2.7, 3.5]],
    ]);
    expect(anchors.map((a) => a?.at)).toEqual([CHAIR, CHAIR, CHAIR]);
    expect(anchors[0]?.seat).toBe(true);
  });

  it("附近没有椅子时就地锁定在首次坐下的位置", () => {
    const [first, second] = run(
      [
        [0, true, [5, 5]],
        [200, true, [5.4, 4.7]],
      ],
      [CHAIR],
    );
    expect([first?.at, first?.seat, second?.at]).toEqual([[5, 5], false, [5, 5]]);
  });

  it("站起持续不到 1 s（坐、站判定翻一帧）不解除；持续满 1 s 才解除", () => {
    const anchors = run([
      [0, true, [2, 3]],
      [200, false, [2, 3]],
      [400, true, [2, 3]],
      [600, false, [2, 3]],
      [600 + RELEASE_MS, false, [2, 3]],
    ]);
    expect(anchors.map((a) => a?.at ?? null)).toEqual([CHAIR, CHAIR, CHAIR, CHAIR, null]);
  });

  it("坐着挪到别处：偏离超过 0.8 m 持续 1.5 s 才换位置，短暂偏离不换", () => {
    const other: Seat = [6, 3];
    const anchors = run(
      [
        [0, true, [2, 3]],
        [200, true, [6, 3]],
        [400, true, [2.1, 3]], // 只偏离一下：仍在原椅子
        [600, true, [6, 3]],
        [600 + HOLD_MS, true, [6, 3]],
      ],
      [CHAIR, other],
    );
    expect(anchors.map((a) => a?.at)).toEqual([CHAIR, CHAIR, CHAIR, CHAIR, other]);
  });

  it("别人已坐的椅子不再吸附", () => {
    const anchor = settle(undefined, true, [2.2, 3], [CHAIR, [3, 3]], 0, [CHAIR]);
    expect(anchor?.at).toEqual([3, 3]);
  });

  it("没坐下时不锁定", () => {
    expect(settle(undefined, false, [2, 3], [CHAIR], 0)).toBeUndefined();
  });
});

describe("可坐的位置", () => {
  it("手工场景：椅子类取占地中心，沙发取长边两侧两个座位，其余资产不算", () => {
    const items = [
      { asset: "office-chair", x: 1, y: 1, rot: 0, len: null },
      { asset: "sofa", x: 4, y: 2, rot: 90, len: null },
      { asset: "desk", x: 7, y: 7, rot: 0, len: null },
    ] as SceneItem[];
    const seats = seatsFromItems(items).map(([x, y]) => [Number(x.toFixed(6)), Number(y.toFixed(6))]);
    expect(seats).toEqual([
      [1, 1],
      [4, 1.5],
      [4, 2.5],
    ]);
  });

  it("自动场景：椅子、沙发与长凳取底面中心，桌柜不算", () => {
    const frame = {
      camera_id: "cam-05",
      surfaces: [],
      walls: [],
      trees: [],
      markings: [],
      objects: [
        { class: "chair", polygon: [[0, 0], [1, 0], [1, 1], [0, 1]], height_m: 0.9 },
        { class: "furniture", kind: "bench", polygon: [[4, 4], [6, 4]], height_m: 0.45 },
        { class: "table", polygon: [[2, 2], [3, 2], [3, 3]], height_m: 0.75 },
      ],
    } as unknown as SceneFrame;
    expect(seatsFromFrames([frame])).toEqual([
      [0.5, 0.5],
      [5, 4],
    ]);
  });
});

describe("补椅子", () => {
  const chair: Asset = { id: "office-chair", category: "furniture", name: "办公椅", file: "scene-furniture.glb", footprint: [1, 1], scale: 2, yaw: 0, line: false };

  it("放在锁定的髋部位置，按目录比例缩放，正面（+z）朝向身体朝向", () => {
    for (const front of [0, Math.PI / 2, Math.PI, -Math.PI / 3]) {
      const [position, turn, scale] = [new Vector3(), new Quaternion(), new Vector3()];
      chairMatrix([4, 5], front, chair).decompose(position, turn, scale);
      expect(position.toArray()).toEqual([4, 0, 5]);
      expect(scale.toArray().map((v) => Number(v.toFixed(6)))).toEqual([2, 2, 2]);
      const facing = new Vector3(0, 0, 1).applyQuaternion(turn);
      // 场景坐标 (x, 高度, 平面 y)：正面落在平面 (cos front, sin front)
      expect(facing.x).toBeCloseTo(Math.cos(front), 5);
      expect(facing.z).toBeCloseTo(Math.sin(front), 5);
    }
  });
});
