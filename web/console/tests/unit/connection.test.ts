import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connect, freshness, STALE_MS, useConnection } from "../../src/store/connection";
import { TRACK_TTL_MS, useLive } from "../../src/store/live";
import { select, useSelection } from "../../src/store/selection";

class FakeSocket {
  static all: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  close() {}
}

const HEARTBEAT = JSON.stringify({ channel: "system", data: { type: "heartbeat" } });
const TRACK = JSON.stringify({
  channel: "tracks",
  data: { camera_id: "cam-01", track_id: 1, x: 1, y: 2, uncertainty_m: 0.3 },
});
const latest = () => FakeSocket.all.at(-1) as FakeSocket;

describe("freshness", () => {
  it("首次连接尚无结果为连接中，之后未连接为断线", () => {
    expect(freshness({ open: false, connecting: true, lastFrameAt: null }, 0)).toBe("connecting");
    expect(freshness({ open: false, connecting: false, lastFrameAt: 0 }, 0)).toBe("offline");
  });

  it("距上一帧不超过 2 个心跳周期为实时，超过为延迟", () => {
    expect(freshness({ open: true, connecting: false, lastFrameAt: 0 }, STALE_MS)).toBe("live");
    expect(freshness({ open: true, connecting: false, lastFrameAt: 0 }, STALE_MS + 1)).toBe("delayed");
  });
});

describe("connect", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeSocket);
    FakeSocket.all = [];
    useConnection.setState(useConnection.getInitialState());
    useLive.setState(useLive.getInitialState());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("连接与收帧时更新状态", () => {
    connect(vi.fn());

    latest().onopen?.();
    expect(useConnection.getState()).toMatchObject({ open: true, lastFrameAt: Date.now() });
    vi.advanceTimersByTime(3000);
    latest().onmessage?.({ data: HEARTBEAT });
    expect(useConnection.getState().lastFrameAt).toBe(Date.now());
  });

  it("收到的推送写入场景数据；化身超时移除，断线期间保留（V-U4）", () => {
    connect(vi.fn());
    latest().onopen?.();

    latest().onmessage?.({ data: TRACK });
    expect(Object.keys(useLive.getState().people)).toEqual(["cam-01/1"]);
    latest().onclose?.({ code: 1006 });
    vi.advanceTimersByTime(TRACK_TTL_MS * 2);
    expect(Object.keys(useLive.getState().people)).toEqual(["cam-01/1"]);

    vi.advanceTimersByTime(1000); // 重连
    latest().onopen?.();
    vi.advanceTimersByTime(1000);
    expect(useLive.getState().people).toEqual({});
  });

  it("首次连接失败后不再视为连接中", () => {
    connect(vi.fn());
    expect(useConnection.getState().connecting).toBe(true);

    latest().onclose?.({ code: 1006 });

    expect(useConnection.getState().connecting).toBe(false);
  });

  it("断开后按 1、2、4 s 退避重连，连上后重置", () => {
    connect(vi.fn());
    latest().onopen?.();

    for (const delay of [1000, 2000, 4000]) {
      latest().onclose?.({ code: 1006 });
      expect(useConnection.getState().open).toBe(false);
      vi.advanceTimersByTime(delay - 1);
      const before = FakeSocket.all.length;
      vi.advanceTimersByTime(1);
      expect(FakeSocket.all.length).toBe(before + 1);
    }
    latest().onopen?.();
    latest().onclose?.({ code: 1006 });
    vi.advanceTimersByTime(1000);
    expect(FakeSocket.all.length).toBe(5);
  });

  it.each([
    ["服务端以 1008 断开", true, 1008],
    ["握手即被拒绝", false, 1006],
  ])("%s时请上层核对会话", (_, opened, code) => {
    const onRejected = vi.fn();
    connect(onRejected);

    if (opened) latest().onopen?.();
    latest().onclose?.({ code });

    expect(onRejected).toHaveBeenCalledOnce();
  });

  it("已连上后普通断开不核对会话", () => {
    const onRejected = vi.fn();
    connect(onRejected);

    latest().onopen?.();
    latest().onclose?.({ code: 1006 });

    expect(onRejected).not.toHaveBeenCalled();
  });

  it("停止后不再重连", () => {
    const stop = connect(vi.fn());
    latest().onopen?.();

    stop();
    latest().onclose?.({ code: 1000 });
    vi.advanceTimersByTime(60_000);

    expect(FakeSocket.all.length).toBe(1);
    expect(useConnection.getState()).toEqual(useConnection.getInitialState());
  });

  it("停止后清空场景数据：重新登录不沿用上次会话的实体", () => {
    const stop = connect(vi.fn());
    latest().onopen?.();
    latest().onmessage?.({ data: TRACK });
    expect(useLive.getState().people).not.toEqual({});

    stop();

    expect(useLive.getState()).toEqual(useLive.getInitialState());
  });

  it("停止后清除选中：重新登录时详情面板收起，不自动连接上次的画面", () => {
    const stop = connect(vi.fn());
    select("cam-01");

    stop();

    expect(useSelection.getState().deviceId).toBeNull();
  });

  it("已停止的旧连接晚到的关闭事件不改写新连接的状态", () => {
    const stop = connect(vi.fn());
    const old = latest();
    stop();
    connect(vi.fn());
    latest().onopen?.();

    old.onclose?.({ code: 1000 });

    expect(useConnection.getState().open).toBe(true);
  });
});
