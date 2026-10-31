import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { components } from "../../src/api/schema";
import { ApiError, api } from "../../src/lib/api";
import { ActionBar, RESULT_TIMEOUT_MS } from "../../src/panels/ActionBar/ActionBar";
import { receive, useLive } from "../../src/store/live";
import { type Role, useSession } from "../../src/store/session";

type Frame = components["schemas"]["WsFrame"];
type Execution = components["schemas"]["playbook_execution.schema"];
const NOW = Date.parse("2026-11-08T02:00:00Z");

const execution = (changes: Partial<Execution> = {}): Execution => ({
  id: "exe-1",
  playbook_id: "isolate-attacker",
  playbook_version: "1.0.0",
  incident_id: "inc-1",
  device_ids: ["cam-02"],
  target: "172.30.0.100",
  state: "contained",
  reason: null,
  ttl_s: 150,
  expires_at: "2026-11-08T02:02:13Z",
  verify_result: { passed: true, reason: "封禁规则已生效，已拦截 8 个数据包" },
  ...changes,
});
const push = (e: Execution) =>
  act(() => receive({ channel: "executions", data: e } as unknown as Frame, NOW));

function show(role: Role | null) {
  useSession.setState({ role });
  return render(<ActionBar deviceId="cam-02" />);
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  useLive.setState(useLive.getInitialState());
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ActionBar", () => {
  it("没有处置时不渲染", () => {
    show("operator");
    expect(screen.queryByRole("region", { name: "处置" })).toBeNull();
  });

  it("已处置：拦截证据、剩余时间每秒更新（D-072）", () => {
    push(execution());
    show("operator");

    expect(screen.getByText("已处置")).toBeTruthy();
    expect(screen.getByText("封禁规则已生效，已拦截 8 个数据包")).toBeTruthy();
    expect(screen.getByText("剩余 2:13")).toBeTruthy();
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByText("剩余 2:12")).toBeTruthy();
  });

  it.each([
    ["viewer", false],
    ["auditor", false],
    [null, false],
    ["operator", true],
    ["admin", true],
  ] as const)("角色 %s：解封按钮渲染 %s（C-FE-07）", (role, visible) => {
    push(execution());
    show(role);
    expect(screen.queryByRole("button", { name: "立即解封" }) !== null).toBe(visible);
  });

  it.each([
    ["executing", "处置中", null],
    ["notify_only", "已通知 · 待联动", "当前部署模式不支持执行，仅通知"],
    ["failed", "处置失败", "privileged-helper 不可达"],
    ["skipped", "未处置", "目标在核心业务白名单内，不处置"],
  ] as const)("%s 显示状态与原因，不渲染解封按钮（V-T1、FR-403、FR-406）", (state, text, reason) => {
    push(execution({ state, reason }));
    show("operator");
    expect(screen.getByText(text)).toBeTruthy();
    if (reason) expect(screen.getByText(reason)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "立即解封" })).toBeNull();
  });

  it("受理后保持不可点，执行器推送解封失败（原因更新）后可再次解封（FR-405、D-075）", async () => {
    const rollback = vi.spyOn(api, "rollback").mockResolvedValue(execution());
    push(execution());
    show("operator");

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "立即解封" })));
    expect(rollback).toHaveBeenCalledWith("exe-1");
    expect(screen.getByRole("button", { name: "解封中…" }).hasAttribute("disabled")).toBe(true);

    push(execution({ reason: "解封失败：privileged-helper 不可达，将于到期时自动解除" }));
    expect(screen.getByRole("button", { name: "立即解封" }).hasAttribute("disabled")).toBe(false);
    expect(screen.getByText("解封失败：privileged-helper 不可达，将于到期时自动解除")).toBeTruthy();
  });

  it("连续两次解封失败且原因相同：第二次的结果推送后即可再点", async () => {
    vi.spyOn(api, "rollback").mockResolvedValue(execution());
    const failed = execution({ reason: "解封失败：privileged-helper 不可达，将于到期时自动解除" });
    push(failed);
    show("operator");

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "立即解封" })));
    push({ ...failed });
    expect(screen.getByRole("button", { name: "立即解封" }).hasAttribute("disabled")).toBe(false);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("执行器推送已解除后按钮消失", async () => {
    vi.spyOn(api, "rollback").mockResolvedValue(execution());
    push(execution());
    show("operator");

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "立即解封" })));
    push(execution({ state: "rolled_back", reason: "由 operator 手动回滚" }));

    expect(screen.getByText("已解除")).toBeTruthy();
    expect(screen.getByText("由 operator 手动回滚")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /解封/ })).toBeNull();
  });

  it("同一设备已处置期间又来待确认或跳过的执行：仍显示已处置与解封按钮", () => {
    push(execution());
    push(execution({ id: "exe-2", state: "pending", expires_at: null, verify_result: null }));
    push(execution({ id: "exe-3", state: "skipped", reason: "互斥：同一目标已有执行", verify_result: null }));
    show("operator");

    expect(screen.getByText("已处置")).toBeTruthy();
    expect(screen.getByRole("button", { name: "立即解封" })).toBeTruthy();
  });

  it("受理后超时未收到执行结果：恢复可点并提示", async () => {
    vi.spyOn(api, "rollback").mockResolvedValue(execution());
    push(execution());
    show("operator");

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "立即解封" })));
    act(() => vi.advanceTimersByTime(RESULT_TIMEOUT_MS));

    expect(screen.getByRole("alert").textContent).toContain("未收到执行结果，请重试");
    expect(screen.getByRole("button", { name: "立即解封" }).hasAttribute("disabled")).toBe(false);
  });

  it("请求被拒时显示原因，可重试", async () => {
    vi.spyOn(api, "rollback").mockRejectedValue(new ApiError(503, "处置执行器暂不可达，请稍后重试"));
    push(execution());
    show("operator");

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "立即解封" })));

    expect(screen.getByRole("alert").textContent).toContain("处置执行器暂不可达，请稍后重试");
    expect(screen.getByRole("button", { name: "立即解封" }).hasAttribute("disabled")).toBe(false);
  });
});
