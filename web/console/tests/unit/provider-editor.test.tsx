import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, api } from "../../src/lib/api";
import { ProviderEditor } from "../../src/panels/ProviderEditor/ProviderEditor";
import type { Provider } from "../../src/panels/ProviderList/ProviderList";

const SAVED: Provider = {
  id: "p-2", name: "DeepSeek 官方", preset: "deepseek", base_url: "https://api.deepseek.com/v1", api_key_last4: "3f9a",
  model: "deepseek-chat", network: "public", network_overridden: false, structured_output: null, timeout_s: 30,
  enabled: false, order: 0, last_test: null, usage_today: { calls: 0, tokens: 0 },
}; // prettier-ignore

const field = (name: string) => screen.getByRole("textbox", { name }) as HTMLInputElement;
const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });
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
    fireEvent.change(screen.getByRole("combobox", { name: "预设" }), { target: { value: "ollama" } });
    expect(field("地址").value).toBe("http://192.168.1.50:11434/v1");
    expect(field("名称").value).toBe("Ollama");
    type(field("模型"), "qwen3");
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
    type(field("地址"), "http://localhost:8080/v1");
    expect(screen.getByRole("alert").textContent).toContain("局域网 IP");
  });

  it("编辑时 Key 留空不修改，显示末 4 位；改判网络位置随请求提交（V-M5）", async () => {
    const update = vi.spyOn(api, "updateProvider").mockResolvedValue(SAVED);
    open(SAVED);
    expect(screen.getByPlaceholderText("已保存 ••••3f9a，留空不修改")).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox", { name: "网络位置" }), { target: { value: "internal" } });
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

  it("名称、地址、模型未填时不可保存", () => {
    open(null);
    expect((screen.getByRole("button", { name: "保存" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
