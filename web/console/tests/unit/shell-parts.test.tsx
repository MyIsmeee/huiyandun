import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KpiTile } from "../../src/panels/KpiTile/KpiTile";
import { ThemeToggle } from "../../src/panels/ThemeToggle/ThemeToggle";
import { useTheme } from "../../src/theme/store";

afterEach(cleanup);

describe("KpiTile", () => {
  it("无数据时显示 —，不显示 0 与单位", () => {
    render(<KpiTile label="活跃告警" value={null} unit="条" />);

    expect(screen.getByText("—")).toBeTruthy();
    expect(screen.queryByText("条")).toBeNull();
  });

  it("有数据时显示数值与单位", () => {
    render(<KpiTile label="活跃告警" value={0} unit="条" />);

    expect(screen.getByText("0")).toBeTruthy();
    expect(screen.getByText("条")).toBeTruthy();
  });
});

describe("ThemeToggle", () => {
  beforeEach(() => {
    useTheme.setState(useTheme.getInitialState());
  });

  it("切换主题", () => {
    render(<ThemeToggle />);

    fireEvent.click(screen.getByRole("button", { name: "切换到亮色" }));

    expect(useTheme.getState().theme).toBe("light");
    expect(screen.getByRole("button", { name: "切换到暗色" })).toBeTruthy();
  });

  it("开关降低动效并标示当前状态", () => {
    render(<ThemeToggle />);
    const button = screen.getByRole("button", { name: "降低动效" });

    fireEvent.click(button);

    expect(useTheme.getState().reducedMotion).toBe(true);
    expect(button.getAttribute("aria-pressed")).toBe("true");
  });
});
