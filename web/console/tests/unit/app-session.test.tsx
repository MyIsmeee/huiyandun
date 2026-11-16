import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "../../src/App";
import { ApiError, api } from "../../src/lib/api";
import { useSession } from "../../src/store/session";

// 主界面另有用例：这里只核对会话与角色的处理
vi.mock("../../src/panels/Shell/Shell", () => ({ Shell: () => <main>主界面</main> }));

beforeEach(() => {
  Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("会话失效（如退出登录）时清空角色：换账户登录后不沿用上一个角色（C-FE-07）", async () => {
  useSession.setState({ role: "operator" });
  vi.spyOn(api, "getSite").mockRejectedValue(new ApiError(401, "未登录"));
  render(<App />);
  await waitFor(() => expect(useSession.getState().role).toBeNull());
});

it("登录响应带角色即用于渲染；会话查询失败时按退避重试并标注，成功后清除", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  useSession.setState({ role: null, roleFailed: false });
  vi.spyOn(api, "getSite").mockResolvedValue({ id: "s", name: "站点", width_m: 1, height_m: 1, areas: [], devices: [] });
  const session = vi
    .spyOn(api, "session")
    .mockRejectedValueOnce(new Error("HTTP 502"))
    .mockResolvedValue({ username: "op", role: "operator", expires_at: "2026-12-01T00:00:00Z" });
  render(<App />);
  await waitFor(() => expect(useSession.getState().roleFailed).toBe(true));
  expect(useSession.getState().role).toBeNull();
  await vi.advanceTimersByTimeAsync(2_000);
  await waitFor(() => expect(useSession.getState().role).toBe("operator"));
  expect(useSession.getState().roleFailed).toBe(false);
  expect(session).toHaveBeenCalledTimes(2);
  vi.useRealTimers();
});
