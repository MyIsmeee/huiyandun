import type { components } from "../api/schema";

type Schemas = components["schemas"];
export type Site = Schemas["Site"];

const TIMEOUT_MS = 10_000;

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** 只经同源 /api 访问 api-server（D-02）；会话凭证在 HttpOnly Cookie 中，脚本不可读（C-FE-06） */
async function send(method: string, path: string, body?: string, type?: string): Promise<Response> {
  const headers: Record<string, string> = { "X-Request-ID": crypto.randomUUID() };
  if (type) headers["Content-Type"] = type;
  const res = await fetch(path, { method, headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) {
    const error = (await res.json().catch(() => null)) as Partial<Schemas["Error"]> | null;
    // 非契约格式的错误响应来自 api-server 之外（如其不可用时反向代理返回的 502 页面），按连接失败处理
    if (typeof error?.message !== "string") throw new Error(`HTTP ${res.status}`);
    throw new ApiError(res.status, error.message);
  }
  return res;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await (body === undefined
    ? send(method, path)
    : send(method, path, JSON.stringify(body), "application/json"));
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export const api = {
  login: (body: Schemas["LoginRequest"]) =>
    request<Schemas["LoginResponse"]>("POST", "/api/auth/login", body),
  logout: () => request<undefined>("POST", "/api/auth/logout"),
  getSite: () => request<Site>("GET", "/api/site"),
  /** 实时画面的 WebRTC 信令：提交 SDP offer，返回 SDP answer（FR-106） */
  webrtc: async (deviceId: string, offer: string) =>
    (await send("POST", `/api/devices/${encodeURIComponent(deviceId)}/webrtc`, offer, "application/sdp")).text(),
};
