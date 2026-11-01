import type { components } from "../api/schema";

type Schemas = components["schemas"];
export type Site = Schemas["Site"];

const TIMEOUT_MS = 10_000;
// 生成报告须等模型逐家尝试，网关总时限 60 s（SC-05）加余量
const REPORT_TIMEOUT_MS = 70_000;

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** 只经同源 /api 访问 api-server（D-02）；会话凭证在 HttpOnly Cookie 中，脚本不可读（C-FE-06） */
async function send(
  method: string,
  path: string,
  body?: string,
  type?: string,
  timeoutMs = TIMEOUT_MS,
): Promise<Response> {
  const headers: Record<string, string> = { "X-Request-ID": crypto.randomUUID() };
  if (type) headers["Content-Type"] = type;
  const res = await fetch(path, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    const error = (await res.json().catch(() => null)) as Partial<Schemas["Error"]> | null;
    // 非契约格式的错误响应来自 api-server 之外（如其不可用时反向代理返回的 502 页面），按连接失败处理
    if (typeof error?.message !== "string") throw new Error(`HTTP ${res.status}`);
    throw new ApiError(res.status, error.message);
  }
  return res;
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  timeoutMs = TIMEOUT_MS,
): Promise<T> {
  const res = await (body === undefined
    ? send(method, path, undefined, undefined, timeoutMs)
    : send(method, path, JSON.stringify(body), "application/json", timeoutMs));
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export const api = {
  login: (body: Schemas["LoginRequest"]) =>
    request<Schemas["LoginResponse"]>("POST", "/api/auth/login", body),
  logout: () => request<undefined>("POST", "/api/auth/logout"),
  /** 当前会话的账户与角色：页面刷新后据此决定渲染哪些操作（C-FE-07） */
  session: () => request<Schemas["Session"]>("GET", "/api/auth/session"),
  getSite: () => request<Site>("GET", "/api/site"),
  /** 手动回滚（FR-405）：受理后返回当前执行状态，结果经 executions 频道推送 */
  rollback: (executionId: string) =>
    request<Schemas["playbook_execution.schema"]>("POST", `/api/executions/${encodeURIComponent(executionId)}/rollback`),
  /** AI 安全值班员的调查记录（FR-1102）；尚未开始调查时为 404 */
  getInvestigation: (incidentId: string) =>
    request<Schemas["Investigation"]>("GET", `/api/incidents/${encodeURIComponent(incidentId)}/investigation`),
  /** 生成溯源报告（FR-501）：没有可用供应商时为模板报告 */
  createReport: (incidentId: string) =>
    request<Schemas["Report"]>(
      "POST",
      `/api/incidents/${encodeURIComponent(incidentId)}/reports`,
      undefined,
      REPORT_TIMEOUT_MS,
    ),
  /** 标记报告已复核（FR-504），写审计 */
  reviewReport: (reportId: string) =>
    request<Schemas["Report"]>("POST", `/api/reports/${encodeURIComponent(reportId)}/review`),
  /** 实时画面的 WebRTC 信令：提交 SDP offer，返回 SDP answer（FR-106） */
  webrtc: async (deviceId: string, offer: string) =>
    (await send("POST", `/api/devices/${encodeURIComponent(deviceId)}/webrtc`, offer, "application/sdp")).text(),
};
