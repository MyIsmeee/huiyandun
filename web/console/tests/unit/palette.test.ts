import { describe, expect, it } from "vitest";
import css from "../../src/theme/theme.css?raw";
import { BODY, POLE_COLOR, STATUS } from "../../src/scene/devices";
import { PALETTE } from "../../src/scene/perceived";
import { FILL } from "../../src/scene/targets";

// 配色校验（V-S5、V-G2、设计 150 §4）：令牌直接取自 theme.css，场景材质取自代码

const token = (name: string): string => {
  const hex = new RegExp(`--${name}: (#[0-9a-f]{6});`, "i").exec(css)?.[1];
  if (!hex) throw new Error(`theme.css 缺少 --${name}`);
  return hex;
};
const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = (hex: string) => {
  const [r, g, b] = rgb(hex).map(linear) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
/** WCAG 2 对比度 */
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};
/** 在 sRGB 中按比例混色，同 CSS color-mix(in srgb, a p, b) */
const mix = (a: string, p: number, b: string) =>
  `#${rgb(a)
    .map((c, i) => Math.round((c * p + (rgb(b)[i] ?? 0) * (1 - p)) * 255).toString(16).padStart(2, "0"))
    .join("")}`;

/** CIE Lab（D65） */
function lab(hex: string): [number, number, number] {
  const [r, g, b] = rgb(hex).map(linear) as [number, number, number];
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const x = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047);
  const y = f(0.2126 * r + 0.7152 * g + 0.0722 * b);
  const z = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
const chroma = (hex: string) => Math.hypot(lab(hex)[1], lab(hex)[2]);

/** CIEDE2000 色差（Sharma 2005） */
function deltaE2000(c1: string, c2: string): number {
  const [L1, a1, b1] = lab(c1);
  const [L2, a2, b2] = lab(c2);
  const rad = Math.PI / 180;
  const C7 = ((Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2) ** 7;
  const G = 0.5 * (1 - Math.sqrt(C7 / (C7 + 25 ** 7)));
  const [ap1, ap2] = [(1 + G) * a1, (1 + G) * a2];
  const [Cp1, Cp2] = [Math.hypot(ap1, b1), Math.hypot(ap2, b2)];
  const hue = (b: number, a: number) => (Math.atan2(b, a) / rad + 360) % 360;
  const [h1, h2] = [hue(b1, ap1), hue(b2, ap2)];
  const zero = Cp1 * Cp2 === 0;
  let dh = h2 - h1;
  if (zero) dh = 0;
  else if (dh > 180) dh -= 360;
  else if (dh < -180) dh += 360;
  const dL = L2 - L1;
  const dC = Cp2 - Cp1;
  const dH = 2 * Math.sqrt(Cp1 * Cp2) * Math.sin((dh / 2) * rad);
  const L = (L1 + L2) / 2;
  const C = (Cp1 + Cp2) / 2;
  let H = h1 + h2;
  if (!zero) H = Math.abs(h1 - h2) <= 180 ? H / 2 : H < 360 ? (H + 360) / 2 : (H - 360) / 2;
  const T = 1 - 0.17 * Math.cos((H - 30) * rad) + 0.24 * Math.cos(2 * H * rad) + 0.32 * Math.cos((3 * H + 6) * rad) - 0.2 * Math.cos((4 * H - 63) * rad);
  const SL = 1 + (0.015 * (L - 50) ** 2) / Math.sqrt(20 + (L - 50) ** 2);
  const SC = 1 + 0.045 * C;
  const SH = 1 + 0.015 * C * T;
  const RT = -2 * Math.sqrt(C ** 7 / (C ** 7 + 25 ** 7)) * Math.sin(60 * Math.exp(-(((H - 275) / 25) ** 2)) * rad);
  return Math.sqrt((dL / SL) ** 2 + (dC / SC) ** 2 + (dH / SH) ** 2 + RT * (dC / SC) * (dH / SH));
}

/** 三个语义状态色；"不确定"本身是中性灰，以虚线 + 半透明区分，不参与材质色差校验 */
const STATES = { physical: STATUS.physical, cyber: STATUS.cyber, contained: STATUS.contained };
const MATERIALS = { ...PALETTE.light, body: BODY, pole: POLE_COLOR, target: FILL, background: token("background") };
const SURFACES = ["card", "background", "secondary"].map(token);

describe("配色校验（V-S5）", () => {
  it.each(Object.entries(MATERIALS))("场景材质 %s %s 彩度 C* ≤ 12", (_, hex) => {
    expect(chroma(hex)).toBeLessThanOrEqual(12);
  });

  it.each(Object.entries(MATERIALS).flatMap(([m, hex]) => Object.entries(STATES).map(([s, state]) => [m, s, hex, state])))(
    "场景材质 %s 与状态色 %s 的 ΔE2000 ≥ 20",
    (_m, _s, hex, state) => {
      expect(deltaE2000(hex, state)).toBeGreaterThanOrEqual(20);
    },
  );

  it.each(Object.entries({ cyber: STATUS.cyber, contained: STATUS.contained, uncertain: STATUS.uncertain }))(
    "状态色 %s 的图标与描边对卡片、页面、悬停底 ≥ 3:1",
    (_, state) => {
      for (const surface of SURFACES) expect(contrast(state, surface)).toBeGreaterThanOrEqual(3);
    },
  );

  it("物理告警黄对白底不足 3:1，故图标为黄色实心 + 深色描线：描线对底、黄对描线均 ≥ 3:1", () => {
    expect(contrast(STATUS.physical, token("card"))).toBeLessThan(3);
    for (const surface of SURFACES) expect(contrast(token("foreground"), surface)).toBeGreaterThanOrEqual(3);
    expect(contrast(STATUS.physical, token("foreground"))).toBeGreaterThanOrEqual(3);
  });

  it.each(Object.entries({ ...STATES, uncertain: STATUS.uncertain }))("状态药丸 %s：12%% 浅底上的深色字 ≥ 4.5:1", (_, state) => {
    expect(contrast(token("foreground"), mix(state, 0.12, token("card")))).toBeGreaterThanOrEqual(4.5);
  });

  it.each(["foreground", "muted-foreground", "subtle-foreground"])("文字色 %s 在卡片、页面、悬停底上 ≥ 4.5:1", (name) => {
    for (const surface of SURFACES) expect(contrast(token(name), surface)).toBeGreaterThanOrEqual(4.5);
  });

  it("强调色：主按钮文字 ≥ 4.5:1，选中描边对卡片 ≥ 3:1", () => {
    expect(contrast(token("primary-foreground"), token("primary"))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(token("primary"), token("card"))).toBeGreaterThanOrEqual(3);
  });

  it("校验函数与参考值一致（WCAG 黑白 21:1、纯红与纯绿 ΔE2000 约 86.6）", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(deltaE2000("#ffffff", "#ffffff")).toBe(0);
    expect(deltaE2000("#ff0000", "#00ff00")).toBeCloseTo(86.6, 0);
  });
});
