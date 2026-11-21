import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../src/lib/api";
import { putSnapshot, usePoster } from "../../src/store/snapshots";

describe("实时画面的垫底截图", () => {
  afterEach(() => vi.restoreAllMocks());

  it("摄像头栏已抓到的画面直接用，不另取；卸载时释放对象 URL", () => {
    const fetch = vi.spyOn(api, "getCameraSnapshot");
    const revoke = vi.fn();
    vi.stubGlobal("URL", { ...URL, createObjectURL: () => "blob:cam-05", revokeObjectURL: revoke });
    putSnapshot("cam-05", new Blob(["jpeg"]));
    const { result, unmount } = renderHook(() => usePoster("cam-05"));
    expect(result.current).toBe("blob:cam-05");
    expect(fetch).not.toHaveBeenCalled();
    unmount();
    expect(revoke).toHaveBeenCalledWith("blob:cam-05");
    vi.unstubAllGlobals();
  });

  it("没有缓存时抓一帧并记下", async () => {
    vi.spyOn(api, "getCameraSnapshot").mockResolvedValue(new Blob(["jpeg"]));
    vi.stubGlobal("URL", { ...URL, createObjectURL: () => "blob:cam-09", revokeObjectURL: vi.fn() });
    const { result } = renderHook(() => usePoster("cam-09"));
    await waitFor(() => expect(result.current).toBe("blob:cam-09"));
    vi.unstubAllGlobals();
  });
});
