import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CalibrationFrame, GroundPlan, type Pair } from "../../src/panels/CameraEditor/CalibrationViews";
import { useLive } from "../../src/store/live";

const AREA = { id: "area-01", name: "一号楼大厅", width_m: 20, depth_m: 10, items: [], updated_at: "2026-11-12T00:00:00Z" };
const PAIRS: Pair[] = [
  [100, 600, 2, 8],
  [300, 520, 5, 7],
];

beforeEach(() => {
  useLive.setState({ site: { id: "demo", name: "演示", width_m: 20, height_m: 10, areas: [AREA], devices: [] } });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("标定画面（V-CAM10）", () => {
  it("点击处按画面原始尺寸换算为像素；已配对与未配对的点按编号显示", () => {
    const onPick = vi.fn();
    const { container } = render(<CalibrationFrame snapshot={{ status: "ready", url: "blob:frame" }} pairs={PAIRS} pending={[700, 360]} hover={null} onPick={onPick} />);
    const img = screen.getByAltText("标定画面") as HTMLImageElement;
    Object.defineProperties(img, { naturalWidth: { value: 1280 }, naturalHeight: { value: 720 } });
    img.getBoundingClientRect = () => ({ left: 10, top: 20, width: 640, height: 360 }) as DOMRect;
    fireEvent.load(img);

    fireEvent.click(img, { clientX: 60, clientY: 320 });

    expect(onPick).toHaveBeenCalledWith([100, 600]);
    const markers = [...container.querySelectorAll("[data-marker]")];
    expect(markers.map((m) => [m.textContent, m.querySelector("circle")?.getAttribute("cx")])).toEqual([
      ["1", "100"],
      ["2", "300"],
      ["3", "700"],
    ]);
    expect(markers[2]?.getAttribute("class")).toContain("animate-pulse");
  });

  it("取不到画面时显示原因，不可点选", () => {
    render(<CalibrationFrame snapshot={{ status: "failed", message: "取画面超时" }} pairs={[]} pending={null} hover={null} onPick={() => {}} />);
    expect(screen.getByText("取不到画面：取画面超时")).toBeTruthy();
    expect(screen.queryByAltText("标定画面")).toBeNull();
  });
});

describe("区域俯视图（V-CAM10）", () => {
  const plan = (onPick = vi.fn()) => {
    const { container } = render(<GroundPlan area={AREA} pairs={PAIRS} hover={1} onPick={onPick} />);
    const svg = screen.getByRole("img", { name: "区域俯视图" });
    // 20×10 m 的区域显示在 300×100 的框内：等比缩放为 10 px/m，左右各留 50 px
    svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 300, height: 100 }) as DOMRect;
    return { svg, container, onPick };
  };

  it("点击处换算为区域内坐标，取 0.1 m；区域外不响应", () => {
    const { svg, onPick } = plan();

    fireEvent.click(svg, { clientX: 50 + 123.4, clientY: 56.78 });
    fireEvent.click(svg, { clientX: 20, clientY: 50 });

    expect(onPick.mock.calls).toEqual([[[12.3, 5.7]]]);
  });

  it("指针处实时显示坐标；悬停的一组放大", () => {
    const { svg, container } = plan();

    fireEvent.mouseMove(svg, { clientX: 50 + 124, clientY: 30 });

    expect(screen.getByText("指针处 x 12.4 y 3.0 m")).toBeTruthy();
    const radius = (n: number) => Number(container.querySelector(`[data-marker="${n}"] circle`)?.getAttribute("r"));
    expect(radius(2)).toBeGreaterThan(radius(1));
  });
});
