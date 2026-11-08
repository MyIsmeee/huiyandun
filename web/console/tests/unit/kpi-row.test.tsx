import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { components } from "../../src/api/schema";
import { api } from "../../src/lib/api";
import { KpiRow } from "../../src/panels/KpiTile/KpiRow";

type Kpis = components["schemas"]["Kpis"];

const KPIS: Kpis = {
  online_devices: { value: 3, delta: -1 },
  active_alerts: { value: 0, delta: 0 },
  contained_today: { value: 2, delta: 2 },
  last_contain_ms: { value: null, delta: null },
};
function tile(label: string): HTMLElement {
  const item = within(screen.getByRole("list", { name: "关键指标" }))
    .getAllByRole("listitem")
    .find((li) => li.textContent?.startsWith(label));
  if (!item) throw new Error(`没有指标 ${label}`);
  return item;
}
const flush = () => act(async () => {});

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("KpiRow", () => {
  it("拉取前为加载态，拉取后显示数值与较 1 小时前的变化；无数据显示 —（ui.md §4）", async () => {
    vi.spyOn(api, "getKpis").mockResolvedValue(KPIS);
    render(<KpiRow stale={false} />);
    expect(within(tile("在线设备")).getByLabelText("加载中")).toBeTruthy();

    await flush();

    expect(tile("在线设备").textContent).toBe("在线设备3台↓ 1");
    expect(tile("在线设备").querySelector("[title]")?.getAttribute("title")).toBe("较 1 小时前");
    expect(tile("活跃告警").textContent).toBe("活跃告警0条持平");
    expect(tile("今日已处置").textContent).toBe("今日已处置2起↑ 2");
    expect(tile("最近处置用时").textContent).toBe("最近处置用时—");
  });

  it("最近处置用时按秒显示 1 位小数，与上一次相比（D-106）", async () => {
    vi.spyOn(api, "getKpis").mockResolvedValue({ ...KPIS, last_contain_ms: { value: 12_340, delta: -2_500 } });
    render(<KpiRow stale={false} />);
    await flush();

    expect(tile("最近处置用时").textContent).toBe("最近处置用时12.3秒↓ 2.5");
    expect(tile("最近处置用时").querySelector("[title]")?.getAttribute("title")).toBe("较上一次");
  });

  it("按浏览器本地当天 0 点起算今日（D-100）", async () => {
    vi.setSystemTime(new Date(2026, 10, 4, 15, 30));
    const get = vi.spyOn(api, "getKpis").mockResolvedValue(KPIS);
    render(<KpiRow stale={false} />);
    await flush();

    expect(get).toHaveBeenCalledWith(new Date(2026, 10, 4).toISOString());
  });

  it("每 5 s 重新拉取；拉取失败保留上次数值并标为非实时，恢复后取消", async () => {
    const get = vi
      .spyOn(api, "getKpis")
      .mockResolvedValueOnce(KPIS)
      .mockRejectedValueOnce(new Error("HTTP 502"))
      .mockResolvedValueOnce({ ...KPIS, online_devices: { value: 4, delta: 0 } });
    render(<KpiRow stale={false} />);
    await flush();

    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(tile("在线设备").textContent).toBe("在线设备3台↓ 1非实时");
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(tile("在线设备").textContent).toBe("在线设备4台持平");
    expect(get).toHaveBeenCalledTimes(3);
  });

  it("首次拉取即失败显示 — 并标为非实时", async () => {
    vi.spyOn(api, "getKpis").mockRejectedValue(new Error("HTTP 502"));
    render(<KpiRow stale={false} />);
    await flush();

    expect(tile("活跃告警").textContent).toBe("活跃告警—非实时");
  });

  it("断线时保留数值并标为非实时（C-FE-05）", async () => {
    vi.spyOn(api, "getKpis").mockResolvedValue(KPIS);
    const { rerender } = render(<KpiRow stale={false} />);
    await flush();
    rerender(<KpiRow stale />);

    expect(tile("今日已处置").textContent).toBe("今日已处置2起↑ 2非实时");
  });

  it("卸载后不再拉取", async () => {
    const get = vi.spyOn(api, "getKpis").mockResolvedValue(KPIS);
    const { unmount } = render(<KpiRow stale={false} />);
    await flush();
    unmount();
    await act(() => vi.advanceTimersByTimeAsync(20_000));
    expect(get).toHaveBeenCalledTimes(1);
  });
});
