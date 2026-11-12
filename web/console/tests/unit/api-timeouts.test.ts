import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../src/lib/api";

describe("初稿识别的等待时限", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // api-server 最多等识别服务 15 s 后返回 503（scene.py 的 RECOGNIZE_TIMEOUT_S）：
  // 页面先放弃的话只会提示"无法连接服务器"，看不到服务端的结论（#288 复核）
  it("比 api-server 等识别服务的 15 s 长", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const body = JSON.stringify({ frames: [], unavailable: [], stale: [] });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 200 })));

    await api.getSceneAreaFrames("area-01");

    expect(timeout.mock.calls.map(([ms]) => ms > 15_000)).toEqual([true]);
  });
});
