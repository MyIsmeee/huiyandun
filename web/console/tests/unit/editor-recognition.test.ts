import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { overlaps } from "../../src/editor/placement";
import { draftFromFrames, type SceneFrame } from "../../src/editor/recognition";
import type { Asset, SceneItem } from "../../src/scene/assets";

// fixtures/scene-*.json：vision-engine 对调试素材录制的分割快照（services/vision-engine/tests/scenes/）按斜视单应投影所得的
// 识别帧——摄像头在 40×24 m 区域的 (20, 2)、朝 +y，画面底边距摄像头 1 m、上方 0.4（教室 0.2）高处距 13 m，视距 22 m
const read = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const CATALOG = new Map<string, Asset>((read("../../public/models/catalog.json") as { assets: Asset[] }).assets.map((a) => [a.id, a]));
const frame = (name: string): SceneFrame => read(`./fixtures/scene-${name}.json`);
const SIZE: [number, number] = [40, 24];
const CAMERAS = [{ id: "cam-01", x: 20, y: 2, yaw_deg: 90 }];
const draft = (frames: SceneFrame[], existing: SceneItem[] = []) => draftFromFrames(frames, CAMERAS, SIZE, existing, CATALOG);
const assets = (items: SceneItem[]) => new Set(items.map((i) => i.asset));
const category = (item: SceneItem) => CATALOG.get(item.asset)?.category;
const empty: Omit<SceneFrame, "camera_id"> = { surfaces: [], walls: [], objects: [], trees: [], markings: [] };

describe("从画面生成初稿（FR-909，设计 150 §7）", () => {
  it("街道：路面铺道路、人行道铺广场地块，建筑立面转为一个建筑块", () => {
    const items = draft([frame("street-1")]);

    expect([...assets(items)]).toEqual(expect.arrayContaining(["road", "plaza"]));
    expect(items.filter((i) => i.asset === "road").every((i) => i.len === 8 && i.rot === 0)).toBe(true);
    expect(items.filter((i) => category(i) === "building")).toHaveLength(1);
  });

  it("乡村路：墙脚线转为墙，栏杆转为围栏", () => {
    expect([...assets(draft([frame("rural-1")]))]).toEqual(expect.arrayContaining(["wall", "fence"]));
  });

  it("教室：课桌转为桌子，后墙转为墙；地板、黑板不转换", () => {
    const items = draft([frame("classroom-1")]);

    expect(items.some((i) => i.asset === "table")).toBe(true);
    expect(items.some((i) => i.asset === "wall")).toBe(true);
    expect([...assets(items)].every((id) => ["table", "wall"].includes(id))).toBe(true);
  });

  it("草稿整块在区域内、彼此不同层重叠，且不覆盖已有物体", () => {
    const frames = ["street-1", "rural-1", "classroom-1"].map(frame);
    const items = draft(frames);

    items.forEach((item, i) => expect(overlaps(item, items.slice(0, i), CATALOG)).toBe(false));
    expect(draft(frames, items)).toEqual([]);
  });

  it("面积不足 2 m² 的地面、短于 1 m 的墙不转换", () => {
    const tiny = { ...empty, camera_id: "cam-01", surfaces: [{ class: "grass" as const, polygon: [[1, 1], [2.9, 1], [2.9, 2], [1, 2]] }] };
    const short = { ...empty, camera_id: "cam-01", walls: [{ class: "wall" as const, line: [[5, 5], [5.8, 5]], height_m: 2.8 }] };

    expect(draft([tiny, short])).toEqual([]);
  });

  it("树按高度转为大树或盆栽，区域外的不转换", () => {
    const trees = [{ x: 5.2, y: 5.4, height_m: 5 }, { x: 10.6, y: 3.3, height_m: 1 }, { x: 41, y: 3, height_m: 5 }];

    expect(draft([{ ...empty, camera_id: "cam-01", trees }])).toEqual([
      { asset: "tree", x: 5, y: 5, rot: 0, len: null },
      { asset: "potted-plant", x: 10.5, y: 3.5, rot: 0, len: null },
    ]);
  });
});
