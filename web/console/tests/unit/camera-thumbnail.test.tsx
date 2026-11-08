import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../src/lib/api";
import { Thumbnail } from "../../src/panels/CameraRail/CameraRail";

let intersect: (visible: boolean) => void = () => {};

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(cb: (entries: { isIntersecting: boolean }[]) => void) {
        intersect = (visible) => cb([{ isIntersecting: visible }]);
      }
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:frame");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("摄像头缩略图按间隔取帧（设计 140 §9）", () => {
  it("取帧在途时切换标签页或滚出滚回，不另起刷新循环", async () => {
    let resolve: (blob: Blob) => void = () => {};
    const snapshot = vi.spyOn(api, "getCameraSnapshot").mockImplementation(() => new Promise((r) => (resolve = r)));
    render(<Thumbnail id="cam-01" offline={false} />);

    act(() => intersect(true));
    expect(snapshot).toHaveBeenCalledTimes(1);
    // 在途期间：页面切走再切回、卡片滚出又滚回
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    act(() => intersect(false));
    act(() => intersect(true));
    expect(snapshot).toHaveBeenCalledTimes(1);

    snapshot.mockResolvedValue(new Blob(["jpeg"]));
    await act(async () => resolve(new Blob(["jpeg"])));
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(snapshot).toHaveBeenCalledTimes(4); // 之后每 10 s 一次，只有一条循环
  });
});
