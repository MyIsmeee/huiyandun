import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, api } from "../../src/lib/api";
import { LoginPage } from "../../src/panels/LoginPage/LoginPage";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function submit() {
  fireEvent.change(screen.getByLabelText("用户名"), { target: { value: "viewer" } });
  fireEvent.change(screen.getByLabelText("密码"), { target: { value: "secret" } });
  fireEvent.click(screen.getByRole("button", { name: "登录" }));
}

describe("登录页", () => {
  it("登录成功后通知上层", async () => {
    vi.spyOn(api, "login").mockResolvedValue({ role: "viewer", expires_at: "2026-10-27T00:00:00Z" });
    const onLogin = vi.fn();
    render(<LoginPage onLogin={onLogin} />);

    submit();

    await vi.waitFor(() => expect(onLogin).toHaveBeenCalledOnce());
    expect(api.login).toHaveBeenCalledWith({ username: "viewer", password: "secret" });
  });

  it("登录成功但仍停留在登录页时提示会话未保存，不一直显示提交中", async () => {
    vi.spyOn(api, "login").mockResolvedValue({ role: "viewer", expires_at: "2026-10-27T00:00:00Z" });
    render(<LoginPage onLogin={() => Promise.resolve()} />);

    submit();

    expect((await screen.findByRole("alert")).textContent).toBe("会话未能保存，请通过 HTTPS 地址访问");
    expect(screen.getByRole("button", { name: "登录" })).toHaveProperty("disabled", false);
  });

  it("用户名或密码错误时提示原因，可再次提交", async () => {
    vi.spyOn(api, "login").mockRejectedValue(new ApiError(401, "用户名或口令错误"));
    const onLogin = vi.fn();
    render(<LoginPage onLogin={onLogin} />);

    submit();

    expect((await screen.findByRole("alert")).textContent).toBe("用户名或密码错误");
    expect(screen.getByRole("button", { name: "登录" })).toHaveProperty("disabled", false);
    expect(onLogin).not.toHaveBeenCalled();
  });

  it("服务不可达时提示稍后重试", async () => {
    vi.spyOn(api, "login").mockRejectedValue(new TypeError("Failed to fetch"));
    render(<LoginPage onLogin={vi.fn()} />);

    submit();

    expect((await screen.findByRole("alert")).textContent).toBe("无法连接服务器，请稍后重试");
  });

  it("可切换显示密码", () => {
    render(<LoginPage onLogin={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "显示密码" }));

    expect(screen.getByLabelText("密码")).toHaveProperty("type", "text");
  });
});
