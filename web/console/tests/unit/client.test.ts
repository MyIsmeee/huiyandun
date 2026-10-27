import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, api } from "../../src/lib/api";

function respond(status: number, body: unknown) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(body, { status }));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("api", () => {
  it("每个请求带 X-Request-ID，请求体以 JSON 发送", async () => {
    const fetch = respond(200, { role: "viewer", expires_at: "2026-10-27T00:00:00Z" });

    await api.login({ username: "u", password: "p" });

    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe("/api/auth/login");
    expect(new Headers(init?.headers).get("X-Request-ID")).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(String(init?.body))).toEqual({ username: "u", password: "p" });
  });

  it("非 2xx 抛出带状态码与服务端说明的错误", async () => {
    respond(401, { code: "unauthorized", message: "未登录或会话失效", request_id: "r" });

    await expect(api.getSite()).rejects.toMatchObject({ status: 401, message: "未登录或会话失效" });
  });

  it("错误响应不是契约格式时按连接失败处理", async () => {
    // 如 api-server 不可用时反向代理返回的 502 页面
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("<html>502</html>", { status: 502 }));

    const error: unknown = await api.getSite().catch((e: unknown) => e);

    expect(error).not.toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ message: "HTTP 502" });
  });
});
