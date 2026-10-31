import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "../../src/App";
import { ApiError, api } from "../../src/lib/api";
import { useSession } from "../../src/store/session";

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
