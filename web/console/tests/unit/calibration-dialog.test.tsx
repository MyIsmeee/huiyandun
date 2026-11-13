import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { components } from "../../src/api/schema";
import { ApiError, api } from "../../src/lib/api";
import { CalibrationDialog } from "../../src/panels/CameraEditor/CalibrationDialog";
import { useLive } from "../../src/store/live";

type Camera = components["schemas"]["Camera"];

const POSE = { x: 10, y: 0, height_m: 3, yaw_deg: 90, pitch_deg: -30, hfov_deg: 90, range_m: 15 };
const CAM: Camera = {
  id: "cam-09",
  name: "大厅",
  ip: "192.168.8.39",
  ingest: "pull",
  source: { protocol: "rtsp", host: "192.168.8.39", port: 554, path: "/live", relay: false },
  username: null,
  password_set: false,
  area_id: "area-01",
  pose: POSE,
  calibration: [],
  calibration_error_m: null,
  climb_lines: [],
  created_at: "2026-11-12T00:00:00Z",
  updated_at: "2026-11-12T00:00:00Z",
};
const AREA = { id: "area-01", name: "一号楼大厅", width_m: 20, depth_m: 10, items: [], updated_at: "2026-11-12T00:00:00Z" };
/** 第 i 组在显示坐标上的点击位置：画面 640×360 显示 1280×720 的帧，俯视图 200×100 显示 20×10 m 的区域 */
const CLICKS = [
  [50, 300, 20, 80],
  [150, 260, 50, 70],
  [250, 220, 80, 60],
  [350, 180, 110, 80],
] as const;
const POINTS = [
  [100, 600, 2, 8],
  [300, 520, 5, 7],
  [500, 440, 8, 6],
  [700, 360, 11, 8],
];

beforeEach(() => {
  useLive.setState({ site: { id: "demo", name: "演示", width_m: 20, height_m: 10, areas: [AREA], devices: [] } });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function open(camera: Camera = CAM) {
  const onSaved = vi.fn();
  const onClose = vi.fn();
  render(<CalibrationDialog camera={camera} areaId="area-01" snapshot={{ status: "ready", url: "blob:frame" }} onClose={onClose} onSaved={onSaved} />);
  const img = screen.getByAltText("标定画面") as HTMLImageElement;
  Object.defineProperties(img, { naturalWidth: { value: 1280 }, naturalHeight: { value: 720 } });
  img.getBoundingClientRect = () => ({ left: 0, top: 0, width: 640, height: 360 }) as DOMRect;
  fireEvent.load(img);
  const plan = screen.getByRole("img", { name: "区域俯视图" });
  plan.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 100 }) as DOMRect;
  const pair = (i: number) => {
    const [cx, cy, px, py] = CLICKS[i] ?? CLICKS[0];
    fireEvent.click(img, { clientX: cx, clientY: cy });
    fireEvent.click(plan, { clientX: px, clientY: py });
  };
  return { plan, pair, onSaved, onClose };
}

const saveButton = () => screen.getByRole("button", { name: "保存" }) as HTMLButtonElement;
const status = () => screen.getByRole("status").textContent ?? "";
const rows = () => within(screen.getByRole("table", { name: "标定点" })).getAllByRole("row").slice(1);

describe("地面标定对话框（V-CAM10、FR-910）", () => {
  it("不足 4 组时提示还差几组、不可保存；第 4 组后检查并建议补点（A13）", async () => {
    const check = vi.spyOn(api, "checkCameraCalibration").mockResolvedValue({ reproj_error_m: 0, residuals_m: [0, 0, 0, 0] });
    const { pair } = open();

    [0, 1, 2].forEach(pair);
    expect(status()).toBe("还差 1 组");
    expect(saveButton().disabled).toBe(true);

    pair(3);
    await waitFor(() => expect(status()).toContain("建议 6 组以上，分散在画面远近、左右各处"));
    expect(check.mock.calls).toEqual([["cam-09", { area_id: "area-01", points: POINTS }]]);
    expect(rows().map((r) => r.textContent)).toContain("2300, 5200.00 m");
    expect(saveButton().disabled).toBe(false);
  });

  it.each([
    [new ApiError(400, "这些点对不上：检查每组画面点与地面点是否对应，画面点是否点在地面上"), "这些点对不上"],
    [new ApiError(503, "识别服务未响应，请稍后重试"), "识别服务未响应，请稍后重试"],
  ])("拟合失败时显示原因、不可保存（A14）", async (error, text) => {
    vi.spyOn(api, "checkCameraCalibration").mockRejectedValue(error);
    const { pair } = open();

    [0, 1, 2, 3].forEach(pair);

    await waitFor(() => expect(status()).toContain(text));
    expect(saveButton().disabled).toBe(true);
  });

  it("误差超过 1 m 时提示，偏差最大的一组加粗，仍可保存（A14）", async () => {
    vi.spyOn(api, "checkCameraCalibration").mockResolvedValue({ reproj_error_m: 1.3, residuals_m: [0.2, 0.3, 2.4, 0.4] });
    const { pair } = open();

    [0, 1, 2, 3].forEach(pair);

    await waitFor(() => expect(status()).toBe("均方根误差 1.30 m · 误差偏大：检查偏差最大的一组"));
    expect(rows().map((r) => r.className.includes("font-semibold"))).toEqual([false, false, true, false]);
    expect(saveButton().disabled).toBe(false);
  });

  it("Esc 撤销未配对的点而不关闭；改地面 x 后俯视图上的点随之移动并重新检查（A15）", async () => {
    const check = vi.spyOn(api, "checkCameraCalibration").mockResolvedValue({ reproj_error_m: 0, residuals_m: [0, 0, 0, 0] });
    const { plan, pair, onClose } = open();

    fireEvent.click(screen.getByAltText("标定画面"), { clientX: 50, clientY: 300 });
    expect(screen.getByText(/第 1 组：在右侧俯视图上点对应位置/)).toBeTruthy();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByText(/第 1 组：/)).toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    [0, 1, 2, 3].forEach(pair);
    await waitFor(() => expect(check).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText("第 1 组地面 x"), { target: { value: "3.5" } });

    expect(plan.querySelector('[data-marker="1"] circle')?.getAttribute("cx")).toBe("3.5");
    await waitFor(() => expect(check).toHaveBeenCalledTimes(2));
    expect(check.mock.calls[1]?.[1].points[0]).toEqual([100, 600, 3.5, 8]);
  });

  it("满 20 组时提示上限；删掉一组后提示消失", async () => {
    vi.spyOn(api, "checkCameraCalibration").mockResolvedValue({ reproj_error_m: 0, residuals_m: Array<number>(20).fill(0) });
    const full = Array.from({ length: 20 }, (_, i) => [i * 50, 400 + i * 10, i % 20, (i * 7) % 10]);
    open({ ...CAM, calibration: full });

    fireEvent.click(screen.getByAltText("标定画面"), { clientX: 50, clientY: 300 });
    expect(screen.getByRole("alert").textContent).toBe("最多 20 组");

    fireEvent.click(screen.getByRole("button", { name: "删除第 20 组" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("保存成功后交回摄像头并关闭；409 时提示原因、保留已点的点", async () => {
    vi.spyOn(api, "checkCameraCalibration").mockResolvedValue({ reproj_error_m: 0.21, residuals_m: [0.2, 0.2, 0.2, 0.2] });
    const saved = { ...CAM, calibration: POINTS, calibration_error_m: 0.21 };
    const save = vi
      .spyOn(api, "saveCameraCalibration")
      .mockRejectedValueOnce(new ApiError(409, "摄像头已换区域，请关闭后重新标定"))
      .mockResolvedValueOnce(saved);
    const { pair, onSaved, onClose } = open();
    [0, 1, 2, 3].forEach(pair);
    await waitFor(() => expect(saveButton().disabled).toBe(false));

    fireEvent.click(saveButton());
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("摄像头已换区域"));
    expect(rows()).toHaveLength(4);

    fireEvent.click(saveButton());
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(saved));
    expect(save.mock.calls[1]).toEqual(["cam-09", { area_id: "area-01", points: POINTS }]);
    expect(onClose).toHaveBeenCalled();
  });

  it("已标定时可二次确认后清除标定", async () => {
    vi.spyOn(api, "checkCameraCalibration").mockResolvedValue({ reproj_error_m: 0.21, residuals_m: [0.2, 0.2, 0.2, 0.2] });
    const save = vi.spyOn(api, "saveCameraCalibration").mockResolvedValue(CAM);
    open({ ...CAM, calibration: POINTS, calibration_error_m: 0.21 });
    expect(rows()).toHaveLength(4);

    fireEvent.click(screen.getByRole("button", { name: "清除标定" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "清除" }));

    await waitFor(() => expect(save).toHaveBeenCalledWith("cam-09", { area_id: "area-01", points: [] }));
  });
});
