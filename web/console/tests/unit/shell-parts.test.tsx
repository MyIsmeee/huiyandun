import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TooltipProvider } from "../../src/components/ui/tooltip";
import { KpiTile } from "../../src/panels/KpiTile/KpiTile";
import { ThemeToggle } from "../../src/panels/ThemeToggle/ThemeToggle";
import { useTheme } from "../../src/theme/store";

afterEach(cleanup);

describe("KpiTile", () => {
  it("无数据时显示 —，不显示 0、单位与趋势", () => {
    render(<KpiTile label="活跃告警" unit="条" data={{ status: "ready", value: null, delta: null }} />);

    expect(screen.getByText("—")).toBeTruthy();
    expect(screen.queryByText("条")).toBeNull();
    expect(screen.queryByTitle("较 1 小时前")).toBeNull();
  });

  it.each([
    [3, "↑ 3"],
    [-2, "↓ 2"],
    [0, "持平"],
  ])("显示数值、单位与较 1 小时前的变化（%i）", (delta, trend) => {
    render(<KpiTile label="活跃告警" unit="条" data={{ status: "ready", value: 0, delta }} />);

    expect(screen.getByText("0")).toBeTruthy();
    expect(screen.getByText("条")).toBeTruthy();
    // 比较基准在悬停提示中，工具条一行放得下（D-115）
    expect(screen.getByText(trend).getAttribute("title")).toBe("较 1 小时前");
  });

  it("加载中只显示占位", () => {
    render(<KpiTile label="活跃告警" unit="条" data={{ status: "loading" }} />);

    expect(screen.getByLabelText("加载中")).toBeTruthy();
    expect(screen.queryByText("—")).toBeNull();
  });

  it("陈旧数据以图标与文字标注非实时（V-S3）", () => {
    render(<KpiTile label="活跃告警" unit="条" data={{ status: "stale", value: 3, delta: null }} />);

    expect(screen.getByText("3")).toBeTruthy();
    expect(screen.getByText("非实时")).toBeTruthy();
  });
});

describe("ThemeToggle", () => {
  beforeEach(() => {
    useTheme.setState(useTheme.getInitialState());
  });

  it("只有降低动效开关，没有主题切换（D-121）", () => {
    render(<ThemeToggle />, { wrapper: TooltipProvider });
    expect(screen.queryByRole("button", { name: /主题/ })).toBeNull();
  });

  it("开关降低动效并标示当前状态", () => {
    render(<ThemeToggle />, { wrapper: TooltipProvider });
    const button = screen.getByRole("button", { name: "降低动效" });

    fireEvent.click(button);

    expect(useTheme.getState().reducedMotion).toBe(true);
    expect(button.getAttribute("aria-pressed")).toBe("true");
  });
});
