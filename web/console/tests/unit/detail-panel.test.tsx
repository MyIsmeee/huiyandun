import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DetailPanel, TargetPanel } from "../../src/panels/DetailPanel/DetailPanel";
import { type Device, type Target, useLive } from "../../src/store/live";

vi.mock("../../src/panels/LiveVideo/LiveVideo", async (original) => ({
  ...(await original<typeof import("../../src/panels/LiveVideo/LiveVideo")>()),
  LiveVideo: ({ deviceId }: { deviceId: string }) => <p>播放 {deviceId}</p>,
}));

afterEach(cleanup);

/** 不含视频流：只测面板本身，不建立 WebRTC 连接 */
const DEVICE: Device = {
  id: "sw-01",
  name: "交换机",
  type: "switch",
  ip: "10.0.0.2",
  mode: "bypass",
  state: "offline",
  alert_severity: null,
  camera: null,
};

describe("DetailPanel", () => {
  it("显示设备基本信息；Esc 与返回按钮回到告警栏（V-I2、D-115）", () => {
    const onClose = vi.fn();
    render(<DetailPanel device={DEVICE} stale={false} onClose={onClose} />);

    expect(screen.getByText("交换机")).toBeTruthy();
    expect(screen.getByText("10.0.0.2")).toBeTruthy();
    expect(screen.getByText("离线")).toBeTruthy();
    expect(screen.getByText("该设备没有视频流")).toBeTruthy();
    expect(screen.queryByText("数据非实时")).toBeNull();
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "返回告警" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("跟随视角下的 Esc 已由场景用于回到总览：详情保留（D-048）", () => {
    const onClose = vi.fn();
    render(<DetailPanel device={DEVICE} stale={false} onClose={onClose} />);
    const consume = (e: KeyboardEvent) => e.preventDefault();
    window.addEventListener("keydown", consume, true);

    fireEvent.keyDown(document.body, { key: "Escape" });

    window.removeEventListener("keydown", consume, true);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("推送断开时状态标注数据非实时（UP-3、V-U3）", () => {
    render(<DetailPanel device={DEVICE} stale onClose={vi.fn()} />);

    expect(screen.getByText("数据非实时")).toBeTruthy();
  });
});

/** 目标详情：所属摄像头的画面以 LiveVideo 播放，这里只核对播放的是哪一路 */
const TARGET: Target = {
  camera_id: "cam-01",
  track_id: 7,
  object_class: "person",
  x: 1,
  y: 2,
  uncertainty_m: 0.42,
  heading_deg: null,
  speed_mps: 1.25,
  bbox: [0, 0, 1, 1],
  keypoints: null,
  trail: [[1, 2, 0]],
};

describe("TargetPanel", () => {
  it("显示类别、跟踪号、速度、所属摄像头、定位误差，并播放所属摄像头的画面（D-054）", () => {
    const onClose = vi.fn();
    render(<TargetPanel target={TARGET} stale={false} onClose={onClose} />);

    expect(screen.getByRole("heading", { name: "人员 #7" })).toBeTruthy();
    expect(screen.getByText("5 km/h")).toBeTruthy();
    expect(screen.getByText("±0.4 m")).toBeTruthy();
    expect(screen.getByText("播放 cam-01")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("尚无速度显示 —；推送断开时标注数据非实时", () => {
    render(<TargetPanel target={{ ...TARGET, speed_mps: null }} stale onClose={vi.fn()} />);

    expect(screen.getByText("—")).toBeTruthy();
    expect(screen.getByText("数据非实时")).toBeTruthy();
  });
});

describe("地面映射（V-CAM9、FR-902、FR-910）", () => {
  const CALIBRATION = [[1, 2, 3, 4], [5, 6, 7, 8], [9, 1, 2, 3], [4, 5, 6, 7]];
  const camera = (mapping: "calibrated" | "estimated", reproj_error_m: number | null): Device => ({
    ...DEVICE,
    id: "cam-01",
    type: "camera",
    state: "normal",
    camera: {
      stream: "cam-01",
      area_id: "area-01",
      pose: { x: 2, y: 2, height_m: 3, yaw_deg: 45, pitch_deg: -30, hfov_deg: 90, range_m: 15 },
      calibration: mapping === "calibrated" ? CALIBRATION : [],
      mapping,
      homography: null,
      reproj_error_m,
    },
  });

  afterEach(() => useLive.setState({ devices: {} }));

  it.each([
    [camera("calibrated", 0.21), "已标定 · 误差 ±0.21 m"],
    [camera("estimated", null), "按安装参数估算"],
  ])("设备详情显示映射方式（A17）", (device, text) => {
    render(<DetailPanel device={device} stale={false} onClose={vi.fn()} />);
    expect(screen.getByText(text)).toBeTruthy();
  });

  it("所属摄像头按安装参数估算时，定位误差注明（A17）", () => {
    useLive.setState({ devices: { "cam-01": camera("estimated", null) } });
    render(<TargetPanel target={TARGET} stale={false} onClose={vi.fn()} />);
    expect(screen.getByText("±0.4 m · 按安装参数估算")).toBeTruthy();
    cleanup();

    useLive.setState({ devices: { "cam-01": camera("calibrated", 0.21) } });
    render(<TargetPanel target={TARGET} stale={false} onClose={vi.fn()} />);
    expect(screen.getByText("±0.4 m")).toBeTruthy();
  });
});
