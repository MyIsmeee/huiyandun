import type { components } from "../api/schema";

type Schemas = components["schemas"];
type Site = Schemas["Site"];

const TIMEOUT_MS = 10_000;

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** 只经同源 /api 访问 api-server（D-02）；会话凭证在 HttpOnly Cookie 中，脚本不可读（C-FE-06） */
async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { "X-Request-ID": crypto.randomUUID() };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const error = (await res.json().catch(() => null)) as Partial<Schemas["Error"]> | null;
    // 非契约格式的错误响应来自 api-server 之外（如其不可用时反向代理返回的 502 页面），按连接失败处理
    if (typeof error?.message !== "string") throw new Error(`HTTP ${res.status}`);
    throw new ApiError(res.status, error.message);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export const api = {
  login: (body: Schemas["LoginRequest"]) =>
    request<Schemas["LoginResponse"]>("POST", "/api/auth/login", body),
  getSite: () => request<Site>("GET", "/api/site"),
};
