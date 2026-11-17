import { describe, expect, it } from "vitest";
import { objectParts } from "../../src/scene/MeasuredScene";
import { furniture, type Piece, styleOf } from "../../src/scene/furniture";

/** 零件在自身坐标中的外接范围：[x, y, z] 各自的 [最小, 最大] */
function extent(p: Piece): [number, number][] {
  const [a, b, c] = p.size;
  if (p.shape === "box") {
    const yaw = p.yaw ?? 0;
    const hx = (Math.abs(Math.cos(yaw)) * a + Math.abs(Math.sin(yaw)) * c) / 2;
    const hz = (Math.abs(Math.sin(yaw)) * a + Math.abs(Math.cos(yaw)) * c) / 2;
    return [[p.at[0] - hx, p.at[0] + hx], [p.at[1] - b / 2, p.at[1] + b / 2], [p.at[2] - hz, p.at[2] + hz]];
  }
  const r = p.shape === "torus" ? a + b : Math.max(a, c);
  return [[p.at[0] - r, p.at[0] + r], [p.at[1] - b / 2, p.at[1] + b / 2], [p.at[2] - r, p.at[2] + r]];
}

describe("家具画法（自动场景白模）", () => {
  it("桌子：按细分类别与尺寸分出茶几、吧台桌、书桌、会议桌、圆桌、餐桌", () => {
    expect(styleOf("table", "coffee_table", 1.2, 0.6, 0.75)).toBe("coffee");
    expect(styleOf("table", "table", 1.2, 0.6, 0.45)).toBe("coffee"); // 矮于 0.55 m 即茶几
    expect(styleOf("table", "table", 0.7, 0.7, 1.05)).toBe("bar");
    expect(styleOf("table", "desk", 1.4, 0.7, 0.75)).toBe("desk");
    expect(styleOf("table", "table", 3.0, 1.2, 0.75)).toBe("conference");
    expect(styleOf("table", "table", 1.0, 0.9, 0.75)).toBe("round");
    expect(styleOf("table", undefined, 1.4, 0.8, 0.75)).toBe("dining");
  });

  it("椅子：转椅、凳子、吧凳、扶手椅、长凳；没有靠背高度的按凳子", () => {
    expect(styleOf("chair", "swivel_chair", 0.6, 0.6, 1.0)).toBe("swivel");
    expect(styleOf("chair", "stool", 0.4, 0.4, 0.45)).toBe("stool");
    expect(styleOf("chair", "stool", 0.4, 0.4, 0.75)).toBe("barstool");
    expect(styleOf("chair", "chair", 0.5, 0.5, 0.5)).toBe("stool");
    expect(styleOf("chair", "armchair", 0.9, 0.85, 0.9)).toBe("armchair");
    expect(styleOf("chair", "seat", 1.6, 0.45, 0.45)).toBe("bench");
    expect(styleOf("chair", "chair", 0.5, 0.5, 0.9)).toBe("chair");
  });

  it("柜子：书架、衣柜、斗柜、矮柜、文件柜、普通柜", () => {
    expect(styleOf("cabinet", "bookcase", 0.9, 0.3, 1.8)).toBe("bookcase");
    expect(styleOf("cabinet", "shelf", 1.2, 0.4, 1.0)).toBe("bookcase");
    expect(styleOf("cabinet", "cabinet", 1.2, 0.6, 2.0)).toBe("wardrobe"); // 高而宽
    expect(styleOf("cabinet", "chest_of_drawers", 0.8, 0.45, 1.0)).toBe("drawers");
    expect(styleOf("cabinet", "cabinet", 1.6, 0.45, 0.8)).toBe("sideboard");
    expect(styleOf("cabinet", "cabinet", 0.5, 0.6, 1.3)).toBe("file");
    expect(styleOf("cabinet", "cabinet", 0.9, 0.5, 1.2)).toBe("cabinet");
  });

  it("每种画法的零件都落在实测底面内、不低于地面，高度与实测相符", () => {
    const cases = [
      ["table", "coffee_table", 1.2, 0.6, 0.45],
      ["table", "table", 0.7, 0.7, 1.05],
      ["table", "table", 1.4, 0.8, 1.05],
      ["table", "desk", 1.4, 0.7, 0.75],
      ["table", "table", 3.0, 1.2, 0.75],
      ["table", "table", 1.0, 0.9, 0.75],
      ["table", undefined, 1.4, 0.8, 0.75],
      ["chair", "swivel_chair", 0.6, 0.6, 1.0],
      ["chair", "stool", 0.4, 0.4, 0.45],
      ["chair", "stool", 0.4, 0.4, 0.75],
      ["chair", "armchair", 0.9, 0.85, 0.9],
      ["chair", "bench", 1.6, 0.45, 0.8],
      ["chair", "chair", 0.5, 0.5, 0.9],
      ["cabinet", "bookcase", 0.9, 0.3, 1.8],
      ["cabinet", "wardrobe", 1.2, 0.6, 2.0],
      ["cabinet", "chest_of_drawers", 0.8, 0.45, 1.0],
      ["cabinet", "cabinet", 1.6, 0.45, 0.8],
      ["cabinet", "cabinet", 0.5, 0.6, 1.3],
      ["cabinet", "cabinet", 0.9, 0.5, 1.2],
      ["sofa", "sofa", 2.0, 0.9, 0.85],
      ["bed", "bed", 2.0, 1.5, 0.6],
      ["furniture", "counter", 2.0, 0.6, 1.0],
      ["street_furniture", "ashcan", 0.4, 0.4, 0.9],
    ] as const;
    const styles = new Set<string>();
    for (const [cls, kind, l, w, h] of cases) {
      const { style, pieces } = furniture(cls, kind, l, w, h);
      styles.add(style);
      expect(pieces.length, style).toBeGreaterThan(cls === "street_furniture" || cls === "furniture" ? 1 : 2);
      const all = pieces.map(extent);
      const span = (axis: number): [number, number] => [Math.min(...all.map((e) => e[axis]?.[0] ?? 0)), Math.max(...all.map((e) => e[axis]?.[1] ?? 0))];
      const [[x0, x1], [y0, y1], [z0, z1]] = [span(0), span(1), span(2)];
      const tol = 0.06;
      expect(Math.max(-x0, x1), `${style} 长`).toBeLessThanOrEqual(l / 2 + tol);
      expect(Math.max(-z0, z1), `${style} 宽`).toBeLessThanOrEqual(w / 2 + tol);
      expect(y0, `${style} 落地`).toBeGreaterThanOrEqual(-1e-6);
      expect(y1, `${style} 高`).toBeGreaterThan(h * 0.8);
      expect(y1, `${style} 高`).toBeLessThan(h * 1.3 + 0.1);
    }
    expect(styles.size).toBe(cases.length - 1); // 两种吧台桌（圆、方）同为 bar
  });

  it("正面转向识别它的摄像头：抽屉拉手在柜子朝摄像头的一侧", () => {
    // 斗柜沿 x 摆放、中心 (5, 5)；摄像头分别在 y 小于、大于 5 的一侧
    const polygon = [[4.6, 4.78], [5.4, 4.78], [5.4, 5.22], [4.6, 5.22]];
    const object = { class: "cabinet", kind: "chest_of_drawers", polygon, height_m: 1.0 } as const;
    for (const cameraY of [0, 10]) {
      const parts = objectParts(object, [5, cameraY]);
      const handles = parts.filter((p) => p.color !== "#FFFFFF" && p.position[1] > 0.1);
      expect(handles.length).toBeGreaterThan(0);
      for (const p of handles) expect(Math.sign(p.position[2] - 5)).toBe(Math.sign(cameraY - 5));
    }
  });
});
