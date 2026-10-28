import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, api } from "../../src/lib/api";
import { LiveVideo } from "../../src/panels/LiveVideo/LiveVideo";

/** 只实现 LiveVideo 用到的部分；jsdom 没有 WebRTC */
class FakePeer {
  static all: FakePeer[] = [];
  connectionState: RTCPeerConnectionState = "new";
  iceGatheringState: RTCIceGatheringState = "complete";
  localDescription: { sdp: string } | null = null;
  remote: string | null = null;
  closed = false;
  ontrack: ((e: { streams: MediaStream[]; track: MediaStreamTrack }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  onicegatheringstatechange: (() => void) | null = null;

  constructor() {
    FakePeer.all.push(this);
  }
  addTransceiver() {}
  async createOffer() {
    return { type: "offer", sdp: "v=0 offer" };
  }
  async setLocalDescription(d: { sdp: string }) {
    this.localDescription = d;
  }
  async setRemoteDescription(d: { sdp: string }) {
    this.remote = d.sdp;
  }
  close() {
    this.closed = true;
  }
  /** 收到画面并连通 */
  play() {
    this.ontrack?.({ streams: [{} as MediaStream], track: {} as MediaStreamTrack });
    this.state("connected");
  }
  state(s: RTCPeerConnectionState) {
    this.connectionState = s;
    this.onconnectionstatechange?.();
  }
}

const peer = () => FakePeer.all.at(-1) as FakePeer;
const video = () => document.querySelector("[data-video]")?.getAttribute("data-video");
const flush = () => act(async () => {});

beforeEach(() => {
  FakePeer.all = [];
  vi.stubGlobal("RTCPeerConnection", FakePeer);
  // jsdom 的 video 不支持 srcObject 与 play
  Object.defineProperty(HTMLMediaElement.prototype, "srcObject", { set() {}, configurable: true });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("LiveVideo", () => {
  it("经 api-server 交换 SDP，收到画面并连通后播放", async () => {
    const signal = vi.spyOn(api, "webrtc").mockResolvedValue("v=0 answer");
    render(<LiveVideo deviceId="cam-01" />);
    expect(video()).toBe("connecting");
    await flush();

    expect(signal).toHaveBeenCalledWith("cam-01", "v=0 offer");
    expect(peer().remote).toBe("v=0 answer");
    act(() => peer().play());
    expect(video()).toBe("playing");
  });

  it("信令失败时不可用并显示服务端说明，重试重新建立连接", async () => {
    vi.spyOn(api, "webrtc").mockRejectedValueOnce(new ApiError(502, "视频服务不可用"));
    render(<LiveVideo deviceId="cam-01" />);
    await flush();

    expect(video()).toBe("unavailable");
    expect(screen.getByText("视频服务不可用")).toBeTruthy();
    expect(peer().closed).toBe(true);

    vi.spyOn(api, "webrtc").mockResolvedValue("v=0 answer");
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await flush();
    expect(FakePeer.all).toHaveLength(2);
    expect(video()).toBe("connecting");
  });

  it("媒体连接中断时保留画面并提示，恢复后继续播放；失败则不可用", async () => {
    vi.spyOn(api, "webrtc").mockResolvedValue("v=0 answer");
    render(<LiveVideo deviceId="cam-01" />);
    await flush();
    act(() => peer().play());

    act(() => peer().state("disconnected"));
    expect(video()).toBe("interrupted");
    act(() => peer().state("connected"));
    expect(video()).toBe("playing");
    act(() => peer().state("failed"));
    expect(video()).toBe("unavailable");
  });

  it("超时仍未取得画面即不可用", async () => {
    vi.useFakeTimers();
    vi.spyOn(api, "webrtc").mockResolvedValue("v=0 answer");
    render(<LiveVideo deviceId="cam-01" />);
    await flush();

    act(() => vi.advanceTimersByTime(10_000));
    expect(video()).toBe("unavailable");
    expect(peer().closed).toBe(true);
  });

  it("卸载时关闭连接，迟到的信令结果不再更新状态", async () => {
    let resolve: (sdp: string) => void = () => {};
    vi.spyOn(api, "webrtc").mockReturnValue(new Promise((r) => (resolve = r)));
    const { unmount } = render(<LiveVideo deviceId="cam-01" />);
    await flush();

    unmount();
    await act(async () => resolve("v=0 answer"));
    expect(peer().closed).toBe(true);
    expect(peer().remote).toBeNull();
  });
});
