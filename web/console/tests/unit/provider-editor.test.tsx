import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, api } from "../../src/lib/api";
import { ProviderEditor, type TestResult } from "../../src/panels/ProviderEditor/ProviderEditor";
import type { Provider } from "../../src/panels/ProviderList/ProviderList";

const SAVED: Provider = {
  id: "p-2", name: "DeepSeek 官方", preset: "deepseek", base_url: "https://api.deepseek.com/v1", api_key_last4: "3f9a",
  model: "deepseek-chat", network: "public", network_overridden: false, structured_output: null, timeout_s: 30,
  enabled: false, order: 0, last_test: null, usage_today: { calls: 0, tokens: 0 },
}; // prettier-ignore
const RESULT: TestResult = {
  health: "failed", tested_at: "2026-11-03T02:00:00Z", suggested_base_url: "https://api.deepseek.com/v1",
  suggested_models: ["deepseek-chat"],
  checks: [{ check: "connectivity", ok: false, latency_ms: null, reason: "地址路径不对", hint: "改为 https://api.deepseek.com/v1" }],
}; // prettier-ignore

const field = (name: string) => screen.getByRole("textbox", { name }) as HTMLInputElement;
const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });
// Radix Select 依赖 jsdom 未实现的指针捕获与滚动定位
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.scrollIntoView ??= () => undefined;
/** 用键盘展开下拉框，再点选项 */
function choose(name: string, option: string) {
  fireEvent.keyDown(screen.getByRole("combobox", { name }), { key: "ArrowDown" });
  fireEvent.click(screen.getByRole("option", { name: option }));
}
function open(provider: Provider | null) {
  const handlers = { onClose: vi.fn(), onSaved: vi.fn() };
  render(<ProviderEditor provider={provider} {...handlers} />);
  return handlers;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ProviderEditor", () => {
  it("选择预设后填入地址模板与名称；只提交填写了的 Key 与改判的网络位置（V-M3、V-M5）", async () => {
    const create = vi.spyOn(api, "createProvider").mockResolvedValue(SAVED);
    const { onClose, onSaved } = open(null);
    choose("预设", "Ollama");
    expect(field("地址").value).toBe("http://192.168.1.50:11434/v1");
    expect(field("名称").value).toBe("Ollama");
    type(screen.getByRole("combobox", { name: "模型" }), "qwen3");
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(create).toHaveBeenCalledWith({
      name: "Ollama", preset: "ollama", base_url: "http://192.168.1.50:11434/v1", model: "qwen3", timeout_s: 60,
    }); // prettier-ignore
    expect(onSaved).toHaveBeenCalled();
  });

  it("地址为 127.0.0.1 或 localhost 时提示改填局域网 IP（V-M3、DP-07）", () => {
    open(null);
    expect(screen.queryByRole("alert")).toBeNull();
    type(field("地址"), "http://localhost.example.com/v1");
    expect(screen.queryByRole("alert")).toBeNull();
    type(field("地址"), "http://localhost:8080/v1");
    expect(screen.getByRole("alert").textContent).toContain("局域网 IP");
  });

  it("编辑时 Key 留空不修改，显示末 4 位；改判网络位置随请求提交（V-M5）", async () => {
    const update = vi.spyOn(api, "updateProvider").mockResolvedValue(SAVED);
    open(SAVED);
    expect(screen.getByPlaceholderText("已保存 ••••3f9a，留空不修改")).toBeTruthy();
    choose("网络位置", "内网");
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(update.mock.calls[0]?.[1]).not.toHaveProperty("api_key");
    expect(update.mock.calls[0]?.[1]).toMatchObject({ network: "internal", timeout_s: 30 });
  });

  it("保存被拒时显示原因，对话框保持打开", async () => {
    vi.spyOn(api, "updateProvider").mockRejectedValue(new ApiError(409, "已开启全局禁止公网供应商"));
    const { onClose } = open(SAVED);
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect((await screen.findByRole("alert")).textContent).toBe("已开启全局禁止公网供应商");
    expect(onClose).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "保存" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("获取列表：新建时凭填写的地址与 Key；已保存且未改地址与 Key 时用已存的 Key（V-M6、D-084）", async () => {
    const discover = vi.spyOn(api, "discoverModels").mockResolvedValue({ models: ["a", "b"] });
    open(null);
    fireEvent.change(screen.getByLabelText("API Key"), { target: { value: "sk-test" } });
    fireEvent.click(screen.getByRole("button", { name: "获取列表" }));
    await waitFor(() => expect(document.querySelectorAll("#provider-models option")).toHaveLength(2));
    expect(discover).toHaveBeenCalledWith({ base_url: "http://192.168.1.50:8080/v1", timeout_s: 60, api_key: "sk-test" });
    cleanup();

    const stored = vi.spyOn(api, "listProviderModels").mockRejectedValue(new ApiError(502, "API Key 无效或无权限；重新填写 Key"));
    open(SAVED);
    fireEvent.click(screen.getByRole("button", { name: "获取列表" }));
    expect((await screen.findByRole("alert")).textContent).toBe("API Key 无效或无权限；重新填写 Key");
    expect(stored).toHaveBeenCalledWith(SAVED);
  });

  it("保存并测试：分项显示原因与改法，建议地址与候选模型一键采用，之后再保存为修改（V-M4、D-084）", async () => {
    const create = vi.spyOn(api, "createProvider").mockResolvedValue(SAVED);
    const update = vi.spyOn(api, "updateProvider").mockResolvedValue(SAVED);
    const test = vi.spyOn(api, "testProvider").mockResolvedValue(RESULT);
    open(null);
    type(field("地址"), "https://api.deepseek.com");
    type(screen.getByRole("combobox", { name: "模型" }), "deepseek-chet");
    fireEvent.click(screen.getByRole("button", { name: "保存并测试" }));
    const result = await screen.findByRole("region", { name: "测试结果" });
    expect(test).toHaveBeenCalledWith(SAVED);
    expect(result.textContent).toContain("地址路径不对；改为 https://api.deepseek.com/v1");

    type(field("地址"), "https://api.deepseek.com");
    fireEvent.click(screen.getByRole("button", { name: "采用" }));
    fireEvent.click(screen.getByRole("button", { name: "deepseek-chat" }));
    expect(field("地址").value).toBe("https://api.deepseek.com/v1");
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith("p-2", expect.objectContaining({ model: "deepseek-chat" })));
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("名称、地址、模型未填或超时不是正整数时不可保存", () => {
    open(SAVED);
    const save = screen.getByRole("button", { name: "保存" }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    type(screen.getByRole("spinbutton"), "1.5");
    expect(save.disabled).toBe(true);
    cleanup();

    open(null);
    expect((screen.getByRole("button", { name: "保存" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "保存并测试" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
