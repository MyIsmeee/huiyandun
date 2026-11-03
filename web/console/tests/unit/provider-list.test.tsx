import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, api } from "../../src/lib/api";
import { type Provider, ProviderPage } from "../../src/panels/ProviderList/ProviderList";

type TestResult = NonNullable<Provider["last_test"]>;
const tested = (health: TestResult["health"], check: TestResult["checks"][number]): TestResult => ({
  checks: [check], health, tested_at: "2026-11-03T02:00:00Z", suggested_base_url: null, suggested_models: [],
}); // prettier-ignore
const provider = (id: string, changes: Partial<Provider> = {}): Provider => ({
  id, name: `供应商 ${id}`, preset: "llama_cpp", base_url: "http://192.168.1.50:8888/v1", api_key_last4: null,
  model: "qwen3", network: "internal", network_overridden: false, structured_output: null, timeout_s: 60,
  enabled: true, order: 0, last_test: null, usage_today: { calls: 0, tokens: 0 }, ...changes,
}); // prettier-ignore
const LOCAL = provider("p-1", {
  structured_output: "json_schema", usage_today: { calls: 48, tokens: 61_234 },
  last_test: tested("ok", { check: "connectivity", ok: true, latency_ms: 312, reason: null, hint: null }),
}); // prettier-ignore
const PUBLIC = provider("p-2", {
  name: "DeepSeek 官方", preset: "deepseek", base_url: "https://api.deepseek.com/v1", api_key_last4: "3f9a",
  network: "public", enabled: false, order: 1,
}); // prettier-ignore

function serve(items: Provider[], blockPublic = false) {
  vi.spyOn(api, "listProviders").mockResolvedValue({ items });
  vi.spyOn(api, "getLlmSettings").mockResolvedValue({ block_public: blockPublic });
}
const card = (name: string) => screen.getByText(name).closest("li") as HTMLElement;

beforeEach(() => serve([LOCAL, PUBLIC]));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ProviderPage", () => {
  it("按顺序列出卡片：网络位置、Key 末 4 位、用量、健康状态，末尾为兜底（V-M1、V-M5、V-M7）", async () => {
    render(<ProviderPage onClose={() => {}} />);
    await screen.findByText("供应商 p-1");
    const local = within(card("供应商 p-1"));
    expect(local.getByText("内网")).toBeTruthy();
    expect(local.getByText(/可用 312 ms/)).toBeTruthy();
    expect(local.getByText(/今日 48 次 · 61.2k tokens · 结构化输出 json_schema/)).toBeTruthy();
    const remote = within(card("DeepSeek 官方"));
    expect(remote.getByText(/Key ••••3f9a/)).toBeTruthy();
    expect(remote.getByRole("switch").getAttribute("aria-checked")).toBe("false");
    const rows = within(screen.getByRole("list", { name: "供应商" })).getAllByRole("listitem");
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringMatching(/^1供应商 p-1/),
      expect.stringMatching(/^2DeepSeek/),
      expect.stringMatching(/^兜底/),
    ]);
  });

  it("测试失败时悬停显示原因、改法与日期时间；停用的供应商同样显示，便于先测再启用（V-M7、FR-602）", async () => {
    const check = { check: "connectivity", ok: false, latency_ms: null, reason: "API Key 无效或无权限", hint: "重新填写 Key" } as const; // prettier-ignore
    serve([{ ...PUBLIC, last_test: tested("failed", check) }]);
    render(<ProviderPage onClose={() => {}} />);
    const failed = await screen.findByText("失败");
    expect(failed.title).toMatch(/^API Key 无效或无权限；重新填写 Key（2026\/11\/3 .+）$/);
  });

  it("停用内网供应商直接提交，之后重新读取列表", async () => {
    const update = vi.spyOn(api, "updateProvider").mockResolvedValue({ ...LOCAL, enabled: false });
    render(<ProviderPage onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("switch", { name: "启用 供应商 p-1" }));
    await waitFor(() => expect(api.listProviders).toHaveBeenCalledTimes(2));
    expect(update).toHaveBeenCalledWith("p-1", { enabled: false });
  });

  it("启用公网供应商先弹确认，写明发送到的主机；取消则不提交（V-M2、G-02）", async () => {
    const update = vi.spyOn(api, "updateProvider").mockResolvedValue({ ...PUBLIC, enabled: true });
    render(<ProviderPage onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("switch", { name: "启用 DeepSeek 官方" }));
    const dialog = screen.getByRole("dialog", { name: "启用公网供应商" });
    expect(dialog.textContent).toContain("脱敏后发送至 api.deepseek.com；视频、图片、流量包不会发送");
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(update).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("switch", { name: "启用 DeepSeek 官方" }));
    fireEvent.click(screen.getByRole("button", { name: "确认启用" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith("p-2", { enabled: true }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("全局禁止公网时公网卡片置灰并注明原因，不可启用、不可测试（V-M2、D-085）", async () => {
    serve([LOCAL, PUBLIC], true);
    render(<ProviderPage onClose={() => {}} />);
    await screen.findByText("DeepSeek 官方");
    const remote = within(card("DeepSeek 官方"));
    expect(remote.getByText("已全局禁止公网供应商")).toBeTruthy();
    expect((remote.getByRole("switch") as HTMLButtonElement).disabled).toBe(true);
    expect((remote.getByRole("button", { name: "测试" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("switch", { name: "禁止公网供应商" }).getAttribute("aria-checked")).toBe("true");
  });

  it("开启全局禁止公网后重新读取列表，以服务端停用结果为准（FR-604）", async () => {
    const settings = vi.spyOn(api, "updateLlmSettings").mockResolvedValue({ block_public: true });
    render(<ProviderPage onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("switch", { name: "禁止公网供应商" }));
    await waitFor(() => expect(api.listProviders).toHaveBeenCalledTimes(2));
    expect(settings).toHaveBeenCalledWith({ block_public: true });
  });

  it("拖到另一张卡上即占据它的位置，提交全部顺序（FR-603）", async () => {
    const reorder = vi.spyOn(api, "reorderProviders").mockResolvedValue(undefined);
    render(<ProviderPage onClose={() => {}} />);
    await screen.findByText("供应商 p-1");
    fireEvent.dragStart(card("DeepSeek 官方"));
    fireEvent.drop(card("供应商 p-1"));
    await waitFor(() => expect(reorder).toHaveBeenCalledWith(["p-2", "p-1"]));
  });

  it("测试连接期间按钮显示测试中，完成后重新读取（FR-602）", async () => {
    let finish = () => {};
    const test = vi.spyOn(api, "testProvider").mockReturnValue(
      new Promise((resolve) => (finish = () => resolve(LOCAL.last_test as TestResult))),
    );
    render(<ProviderPage onClose={() => {}} />);
    await screen.findByText("供应商 p-1");
    fireEvent.click(within(card("供应商 p-1")).getByRole("button", { name: "测试" }));
    expect(screen.getByRole("button", { name: "测试中…" })).toBeTruthy();
    finish();
    await waitFor(() => expect(api.listProviders).toHaveBeenCalledTimes(2));
    expect(test).toHaveBeenCalledWith(expect.objectContaining({ id: "p-1", timeout_s: 60 }));
  });

  it("删除须确认（FR-601）", async () => {
    const remove = vi.spyOn(api, "deleteProvider").mockResolvedValue(undefined);
    render(<ProviderPage onClose={() => {}} />);
    await screen.findByText("供应商 p-1");
    fireEvent.click(within(card("供应商 p-1")).getByRole("button", { name: "删除" }));
    expect(screen.getByRole("dialog", { name: "删除供应商" }).textContent).toContain("删除供应商“供应商 p-1”？");
    expect(remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith("p-1"));
  });

  it("添加与编辑打开对话框，编辑时带出该供应商（FR-601）", async () => {
    render(<ProviderPage onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "添加" }));
    expect(screen.getByRole("dialog", { name: "添加供应商" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    fireEvent.click(within(card("DeepSeek 官方")).getByRole("button", { name: "编辑" }));
    expect((screen.getByRole("textbox", { name: "名称" }) as HTMLInputElement).value).toBe("DeepSeek 官方");
  });

  it("服务端拒绝变更时显示原因", async () => {
    vi.spyOn(api, "updateProvider").mockRejectedValue(new ApiError(404, "供应商不存在"));
    render(<ProviderPage onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("switch", { name: "启用 供应商 p-1" }));
    expect((await screen.findByRole("alert")).textContent).toBe("供应商不存在");
  });

  it("没有供应商时说明使用规则模板，兜底仍在", async () => {
    serve([]);
    render(<ProviderPage onClose={() => {}} />);
    expect(await screen.findByText("尚未添加供应商，报告使用规则模板生成")).toBeTruthy();
    expect(screen.getByText("规则模板报告")).toBeTruthy();
  });

  it("读取失败时提示并可重试", async () => {
    vi.spyOn(api, "listProviders").mockRejectedValueOnce(new Error("HTTP 502"));
    render(<ProviderPage onClose={() => {}} />);
    expect((await screen.findByRole("alert")).textContent).toBe("无法连接服务器，请重试");
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("供应商 p-1")).toBeTruthy();
  });
});
