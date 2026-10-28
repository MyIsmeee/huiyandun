import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DetailPanel } from "../../src/panels/DetailPanel/DetailPanel";
import type { Device } from "../../src/store/live";

afterEach(cleanup);

/** 不含视频流：只测面板本身，不建立 WebRTC 连接 */
const DEVICE: Device = {
  id: "sw-01",
  type: "switch",
  ip: "10.0.0.2",
  mode: "bypass",
  state: "offline",
  alert_severity: null,
  camera: null,
};

describe("DetailPanel", () => {
  it("显示设备基本信息；Esc 与关闭按钮收起（V-I2）", () => {
    const onClose = vi.fn();
    render(<DetailPanel device={DEVICE} onClose={onClose} />);

    expect(screen.getByText("交换机")).toBeTruthy();
    expect(screen.getByText("10.0.0.2")).toBeTruthy();
    expect(screen.getByText("离线")).toBeTruthy();
    expect(screen.getByText("该设备没有视频流")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "关闭详情" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
