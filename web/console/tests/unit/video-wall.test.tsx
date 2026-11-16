import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../src/lib/api";
import { VideoWall } from "../../src/panels/VideoWall/VideoWall";
import type { Device } from "../../src/store/live";
import { select } from "../../src/store/selection";
import { useWall } from "../../src/store/wall";

const camera = (id: string) => ({ id, name: id, kind: "camera", state: "normal", camera: { mapping: "estimated" } }) as unknown as Device;

beforeEach(() => {
  vi.stubGlobal(
    "RTCPeerConnection",
    class {
      connectionState = "new";
      iceGatheringState = "complete";
      addTransceiver() {}
      async createOffer() {
        return { type: "offer", sdp: "" };
      }
      async setLocalDescription() {}
      close() {}
    },
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private cb: (entries: { contentRect: { width: number; height: number } }[]) => void) {}
      observe() {
        this.cb([{ contentRect: { width: 1600, height: 900 } }]);
      }
      disconnect() {}
    },
  );
  vi.spyOn(api, "webrtc").mockReturnValue(new Promise(() => {}));
  useWall.setState({ layout: "auto", page: 0, zoomed: null });
  select(null);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("监控墙放大（V-W4）", () => {
  it("放大时选中另一台摄像头，放大随之换到它", async () => {
    render(<VideoWall devices={[camera("cam-01"), camera("cam-02"), camera("cam-03")]} />);
    act(() => useWall.setState({ zoomed: "cam-01" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(1);

    await act(async () => select("cam-02"));
    expect(useWall.getState().zoomed).toBe("cam-02");
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
  });
});
