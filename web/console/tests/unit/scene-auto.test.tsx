import { act, renderHook } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../src/lib/api";
import * as assets from "../../src/scene/assets";
import { useAutoItems } from "../../src/scene/autoScene";

const read = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const catalog = read("../../public/models/catalog.json") as { assets: assets.Asset[]; categories: assets.Category[] };
const AREA = { id: "area-02", name: "办公室", width_m: 12, depth_m: 10, items: [], updated_at: "2026-11-16T08:00:00Z" };
const DEVICE = {
  id: "cam-05", name: "cam-05", type: "camera", ip: "192.168.5.229", mode: "host_probe", state: "normal", alert_severity: null,
  camera: { stream: "cam-05", area_id: "area-02", pose: { x: 0.5, y: 0.5, height_m: 1.8, yaw_deg: 45, pitch_deg: -10, hfov_deg: 75, range_m: 15 },
    calibration: [], mapping: "estimated", homography: null, reproj_error_m: null, climb_lines: [], rules: [] },
} as never;
const FRAMES = {
  frames: [{ schema_version: "1.1.0", event_id: "00000000-0000-4000-8000-000000000005", ts: "2026-11-16T08:00:00Z", camera_id: "cam-05", surfaces: [], walls: [], trees: [], markings: [],
    objects: [{ class: "table" as const, polygon: [[3, 3], [5, 3], [5, 4], [3, 4]], height_m: 0.78 }] }],
  unavailable: [], stale: [],
} as unknown as Awaited<ReturnType<typeof api.getSceneAreaAuto>>; // prettier-ignore；生成的类型把契约的 $defs 当成了字段

afterEach(() => vi.restoreAllMocks());

describe("场景自动识别（态势页）", () => {
  it("区域没有手工物体：按自动识别的结果生成物体显示", async () => {
    vi.spyOn(assets, "loadCatalog").mockResolvedValue({ assets: new Map(catalog.assets.map((a) => [a.id, a])), categories: catalog.categories });
    const auto = vi.spyOn(api, "getSceneAreaAuto").mockResolvedValue(FRAMES);
    const { result } = renderHook(() => useAutoItems(AREA, [DEVICE]));
    await act(async () => {});

    expect(auto).toHaveBeenCalledWith("area-02");
    expect(result.current?.map((i) => i.asset)).toEqual(["table"]);
  });

  it("区域已有手工物体：以手工为准，不读取自动识别", async () => {
    const auto = vi.spyOn(api, "getSceneAreaAuto").mockResolvedValue(FRAMES);
    const manual = { ...AREA, items: [{ asset: "chair", x: 1.5, y: 1.5, rot: 0 as const, len: null }] };
    const { result } = renderHook(() => useAutoItems(manual, [DEVICE]));
    await act(async () => {});

    expect(auto).not.toHaveBeenCalled();
    expect(result.current).toBeNull();
  });
});
