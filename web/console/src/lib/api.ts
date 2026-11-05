import type { components } from "../api/schema";

type Schemas = components["schemas"];
export type Site = Schemas["Site"];

const TIMEOUT_MS = 10_000;
// 生成报告须等模型逐家尝试，网关总时限 60 s（SC-05）加余量
const REPORT_TIMEOUT_MS = 70_000;
// api-server 向 evidence-service 取包时限 30 s（evidence_timeout_s），包含录像可达数十 MB，再加传输余量
const EVIDENCE_TIMEOUT_MS = 60_000;

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
  /** 确认处置（FR-407）：只提交关联事件 ID，受理后执行结果经 executions 频道推送 */
  confirmContainment: async (incidentId: string) => {
    await send("POST", `/api/incidents/${encodeURIComponent(incidentId)}/confirm-containment`);
  },
  /** 生成溯源报告（FR-501）：没有可用供应商时为模板报告 */
  createReport: (incidentId: string) =>
    request<Schemas["Report"]>(
      "POST",
      `/api/incidents/${encodeURIComponent(incidentId)}/reports`,
      undefined,
      REPORT_TIMEOUT_MS,
    ),
  /** 该关联事件的历史报告，按生成时间倒序（TK-071） */
  listReports: (incidentId: string) =>
    request<Schemas["ReportList"]>("GET", `/api/incidents/${encodeURIComponent(incidentId)}/reports`),
  /** 导出关联事件的证据包 zip（FR-702），写审计；存证尚未写入或没有记录时为 404 */
  exportEvidence: async (incidentId: string) =>
    (
      await send(
        "POST",
        `/api/incidents/${encodeURIComponent(incidentId)}/evidence/export`,
        undefined,
        undefined,
        EVIDENCE_TIMEOUT_MS,
      )
    ).blob(),
  /** 标记报告已复核（FR-504），写审计 */
  reviewReport: (reportId: string) =>
    request<Schemas["Report"]>("POST", `/api/reports/${encodeURIComponent(reportId)}/review`),
  /** 顶栏模型状态（V-M8）：正常 / 已切换 / 模板模式，全部角色可读 */
  getLlmStatus: () => request<Schemas["LlmStatus"]>("GET", "/api/llm/status"),
  /** 大屏关键指标（D-100）：dayStart 为浏览器本地当天 0 点的 ISO 时刻 */
  getKpis: (dayStart: string) =>
    request<Schemas["Kpis"]>("GET", `/api/kpis?day_start=${encodeURIComponent(dayStart)}`),
  /** 模型供应商（FR-601～604），只有 admin 可用；顺序即故障转移顺序 */
  /** 摄像头登记表（FR-905，D-101），仅 admin */
  listCameras: () => request<Schemas["CameraList"]>("GET", "/api/cameras"),
  createCamera: (body: Schemas["CameraCreate"]) => request<Schemas["Camera"]>("POST", "/api/cameras", body),
  updateCamera: (id: string, body: Schemas["CameraUpdate"]) =>
    request<Schemas["Camera"]>("PATCH", `/api/cameras/${encodeURIComponent(id)}`, body),
  deleteCamera: (id: string) => request<undefined>("DELETE", `/api/cameras/${encodeURIComponent(id)}`),
  /** 经 go2rtc 取一帧（V-CAM4）；首帧须等关键帧，api-server 等 8 s，这里再加余量 */
  getCameraSnapshot: async (id: string) =>
    (await send("GET", `/api/cameras/${encodeURIComponent(id)}/snapshot`, undefined, undefined, 12_000)).blob(),
  listProviders: () => request<Schemas["LlmProviderList"]>("GET", "/api/llm/providers"),
  createProvider: (body: Schemas["LlmProviderCreate"]) =>
    request<Schemas["LlmProvider"]>("POST", "/api/llm/providers", body),
  /** 模型列表最多向供应商发 2 次请求（补 /v1 重试），时限按 timeout_s × 2 加余量（CD-04） */
  listProviderModels: (provider: Pick<Schemas["LlmProvider"], "id" | "timeout_s">) =>
    request<Schemas["ModelList"]>(
      "GET",
      `/api/llm/providers/${encodeURIComponent(provider.id)}/models`,
      undefined,
      (provider.timeout_s * 2 + 10) * 1000,
    ),
  /** 保存前凭地址与 Key 获取模型列表（D-084），不保存任何内容 */
  discoverModels: (body: Schemas["ModelDiscovery"] & { timeout_s: number }) =>
    request<Schemas["ModelList"]>("POST", "/api/llm/models", body, (body.timeout_s * 2 + 10) * 1000),
  updateProvider: (id: string, body: Schemas["LlmProviderUpdate"]) =>
    request<Schemas["LlmProvider"]>("PATCH", `/api/llm/providers/${encodeURIComponent(id)}`, body),
  deleteProvider: (id: string) => request<undefined>("DELETE", `/api/llm/providers/${encodeURIComponent(id)}`),
  /** 测试连接最多向供应商发 4 次请求，api-server 按 timeout_s × 4 + 5 s 等网关（CD-04），这里再加余量 */
  testProvider: (provider: Pick<Schemas["LlmProvider"], "id" | "timeout_s">) =>
    request<Schemas["ProviderTestResult"]>(
      "POST",
      `/api/llm/providers/${encodeURIComponent(provider.id)}/test`,
      undefined,
      (provider.timeout_s * 4 + 10) * 1000,
    ),
  reorderProviders: (ids: string[]) =>
    request<undefined>("PUT", "/api/llm/providers/order", { provider_ids: ids }),
  getLlmSettings: () => request<Schemas["LlmSettings"]>("GET", "/api/llm/settings"),
  updateLlmSettings: (body: Schemas["LlmSettings"]) =>
    request<Schemas["LlmSettings"]>("PUT", "/api/llm/settings", body),
  /** 实时画面的 WebRTC 信令：提交 SDP offer，返回 SDP answer（FR-106） */
  webrtc: async (deviceId: string, offer: string) =>
    (await send("POST", `/api/devices/${encodeURIComponent(deviceId)}/webrtc`, offer, "application/sdp")).text(),
};
