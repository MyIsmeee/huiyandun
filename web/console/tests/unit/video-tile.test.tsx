import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VideoTileView } from "../../src/panels/VideoWall/VideoTile";

const props = () => ({
  device: { id: "cam-01", name: "东门", state: "normal" as const },
  selected: false,
  persons: 0,
  vehicles: 0,
  unmapped: false,
  onSelect: vi.fn(),
  onZoom: vi.fn(),
  onRetry: vi.fn(),
  status: { kind: "unavailable" as const, reason: "视频服务不可用" },
});

afterEach(cleanup);

describe("监控墙瓦片（V-W2）", () => {
  it("单击、双击、回车瓦片：选中、放大该路", () => {
    const p = props();
    render(<VideoTileView {...p} />);
    const tile = screen.getByRole("button", { name: "cam-01 东门" });
    fireEvent.click(tile);
    fireEvent.doubleClick(tile);
    fireEvent.keyDown(tile, { key: "Enter" });
    expect(p.onSelect).toHaveBeenCalledTimes(2);
    expect(p.onZoom).toHaveBeenCalledOnce();
  });

  it("点瓦片内的重试只重连，不连带选中或放大", () => {
    const p = props();
    render(<VideoTileView {...p} />);
    const retry = screen.getByRole("button", { name: "重试" });
    fireEvent.click(retry);
    fireEvent.doubleClick(retry);
    fireEvent.keyDown(retry, { key: "Enter" });
    expect(p.onRetry).toHaveBeenCalledOnce();
    expect(p.onSelect).not.toHaveBeenCalled();
    expect(p.onZoom).not.toHaveBeenCalled();
  });
});
