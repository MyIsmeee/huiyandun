import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../src/lib/api";
import { type LlmStatus, LlmStatusBadge } from "../../src/panels/LlmStatusBadge/LlmStatusBadge";

const badge = () => screen.getByRole("status", { name: "模型状态" });
const flush = () => act(async () => {});

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("LlmStatusBadge", () => {
  it.each([
    [{ state: "normal", provider_name: "本地 llama.cpp", reason: null }, "模型：本地 llama.cpp", "模型：本地 llama.cpp"],
    [{ state: "failover", provider_name: "DeepSeek 备用", reason: null }, "已切换至 DeepSeek 备用", "已切换至 DeepSeek 备用"],
    [{ state: "template", provider_name: null, reason: "未启用任何模型供应商" }, "模板模式", "未启用任何模型供应商"],
  ] as const)("%o 显示为 %s（V-M8）", async (status, text, title) => {
    vi.spyOn(api, "getLlmStatus").mockResolvedValue(status as LlmStatus);
    render(<LlmStatusBadge />);
    expect(badge().textContent).toBe("模型状态…");

    await flush();

    expect(badge().textContent).toBe(text);
    expect(badge().getAttribute("title")).toBe(title);
  });

  it("每 5 s 重新拉取，故障转移后同步更新；拉取失败显示未知（FR-606）", async () => {
    const get = vi
      .spyOn(api, "getLlmStatus")
      .mockResolvedValueOnce({ state: "normal", provider_name: "本地", reason: null })
      .mockResolvedValueOnce({ state: "failover", provider_name: "备用", reason: null })
      .mockRejectedValueOnce(new Error("HTTP 502"));
    render(<LlmStatusBadge />);
    await flush();
    expect(badge().textContent).toBe("模型：本地");

    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(badge().textContent).toBe("已切换至 备用");
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(badge().textContent).toBe("模型状态未知");
    expect(get).toHaveBeenCalledTimes(3);
  });

  it("卸载后不再拉取", async () => {
    const get = vi.spyOn(api, "getLlmStatus").mockResolvedValue({ state: "normal", provider_name: "本地", reason: null });
    const { unmount } = render(<LlmStatusBadge />);
    await flush();
    unmount();
    await act(() => vi.advanceTimersByTimeAsync(20_000));
    expect(get).toHaveBeenCalledTimes(1);
  });
});
