import type { SceneFrame } from "../editor/recognition";

/**
 * 自动场景的家具白模（MeasuredScene）：按识别出的细分类别（kind，分割模型 ADE20K 的原始类别）与实测长宽高
 * 选一种画法，再按实测尺寸生成零件。细分类别常给错或缺省（旧缓存、平面投影版），尺寸是更可靠的依据：
 * 矮于 0.55 m 的桌子是茶几，高于 0.95 m 的是吧台桌；没有靠背高度的椅子是凳子；高而宽的柜子是衣柜。
 *
 * 零件在物体自身坐标中：x 沿底面长边，y 向上（离地），z 沿短边；+z 为正面（调用方转向摄像头一侧，
 * 摄像头看得见的多是正面），抽屉缝、柜门、坐垫朝 +z，靠背、床头、挡板在 −z 或 −x
 */

export type Kind = NonNullable<SceneFrame["objects"][number]["kind"]>;

/** 零件色调：主体（白）、骨架（腿、底座，浅灰）、缝线与把手（深一档） */
export type Tone = "body" | "frame" | "detail";

export interface Piece {
  /** box：[长, 高, 宽]；cylinder：[顶半径, 高, 底半径]；torus：[半径, 管半径, 0]，平放 */
  shape: "box" | "cylinder" | "torus";
  size: [number, number, number];
  /** 零件中心（物体自身坐标，米） */
  at: [number, number, number];
  tone: Tone;
  /** 绕竖直轴的转角（弧度），如转椅的五星脚 */
  yaw?: number;
}

export type Style =
  | "dining"
  | "desk"
  | "conference"
  | "round"
  | "coffee"
  | "bar"
  | "chair"
  | "swivel"
  | "stool"
  | "barstool"
  | "armchair"
  | "bench"
  | "cabinet"
  | "file"
  | "drawers"
  | "sideboard"
  | "wardrobe"
  | "bookcase"
  | "sofa"
  | "bed"
  | "counter"
  | "ashcan"
  | "pole"
  | "block";

const TOP = 0.04;
const LEG = 0.05;
/** 识别的椅子底面常连带坐着的人：椅子按常见尺寸截断 */
const CHAIR_MAX_M = 0.6;
/** 物体底面长边上限：超出的多是把一排东西连在一起 */
const OBJECT_MAX_M = 3.5;
/**
 * 并排的椅子在点云中连成一簇（相距不到 0.2 m 栅格）：底面某一边达到 CHAIR_ROW_MIN_M 即按 CHAIR_PITCH_M 的间距排开多把，
 * 不当成一把椅子截断。一把椅子连带坐着的人约 1 m，按间距取整仍是 1 把
 */
const CHAIR_ROW_MIN_M = 1.1;
/**
 * 短边（进深方向）要更长才算前后两排：椅子连带坐着的人、掩码外扩到椅背后的地面，进深常到 1.3 m 以上
 * （2026-11-18 实测：并排两把扶手转椅的簇为 1.53 × 1.34 m）
 */
const CHAIR_BLOCK_MIN_M = 1.8;
const CHAIR_PITCH_M = 0.7;
const ROW_MAX = 6;
/** 一边排开的把数 */
export const chairCount = (side: number) => (side < CHAIR_ROW_MIN_M ? 1 : clamp(Math.round(side / CHAIR_PITCH_M), 2, ROW_MAX));
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** 画法：细分类别优先，尺寸兜底（见文件说明）；length ≥ width */
export function styleOf(cls: SceneFrame["objects"][number]["class"], kind: Kind | null | undefined, length: number, width: number, height: number): Style {
  switch (cls) {
    case "table":
      if (kind === "coffee_table" || height < 0.55) return "coffee";
      if (height > 0.95) return "bar";
      if (kind === "desk") return "desk";
      if (length >= 2.4) return "conference";
      if (length / Math.max(width, 0.01) < 1.25 && length <= 1.5) return "round";
      return "dining";
    case "chair":
      // 长条的"座位"（ADE20K seat）是长凳；其余椅子连成长条是并排的几把（furniture 排开）
      if (kind === "bench" || (kind === "seat" && length >= CHAIR_ROW_MIN_M)) return "bench";
      if (kind === "armchair") return "armchair";
      if (kind === "stool") return height >= 0.62 ? "barstool" : "stool";
      if (height <= 0.6) return "stool"; // 没有高出座面的靠背
      if (kind === "swivel_chair") return "swivel";
      return "chair";
    case "cabinet":
      if (kind === "bookcase" || kind === "shelf") return "bookcase";
      if (kind === "wardrobe" || (height >= 1.7 && length >= 0.8)) return "wardrobe";
      if (kind === "chest_of_drawers") return "drawers";
      if (height <= 0.9) return length >= 1.0 ? "sideboard" : "drawers";
      if (length <= 0.6) return "file";
      return "cabinet";
    case "sofa":
      return "sofa";
    case "bed":
      return "bed";
    case "furniture":
      return kind === "counter" ? "counter" : "block";
    case "street_furniture":
      if (kind === "bench") return "bench";
      if (kind === "ashcan") return "ashcan";
      if (kind === "pole" || kind === "streetlight" || kind === "traffic_light") return "pole";
      return "block";
    case "appliance":
    case "box":
    case "fixture":
      // 有对应模型的由 measuredModels 摆放模型；这里只画没有模型的（风扇、浴缸等）
      return "block";
  }
}

const box = (l: number, h: number, w: number, x: number, y: number, z: number, tone: Tone = "body", yaw?: number): Piece => ({
  shape: "box",
  size: [Math.max(l, 0.005), Math.max(h, 0.005), Math.max(w, 0.005)],
  at: [x, y, z],
  tone,
  ...(yaw === undefined ? {} : { yaw }),
});
const cylinder = (r: number, h: number, x: number, y: number, z: number, tone: Tone = "body", bottom = r): Piece => ({
  shape: "cylinder",
  size: [r, Math.max(h, 0.005), bottom],
  at: [x, y, z],
  tone,
});
/** 自 y0 到 y1 的竖直方块 */
const column = (l: number, w: number, x: number, z: number, y0: number, y1: number, tone: Tone = "frame") => box(l, y1 - y0, w, x, (y0 + y1) / 2, z, tone);
/** 四条腿：内缩 inset，高 h */
const legs = (l: number, w: number, h: number, inset = LEG, size = LEG): Piece[] =>
  [-1, 1].flatMap((i) => [-1, 1].map((j) => column(size, size, i * (l / 2 - inset), j * (w / 2 - inset), 0, h)));
/** 正面（+z，深 w 的柜体）上 n 个抽屉：缝线与居中的拉手，自 y0 到 y1 */
function drawers(l: number, w: number, y0: number, y1: number, n: number): Piece[] {
  const z = w / 2 + 0.004;
  const step = (y1 - y0) / n;
  return Array.from({ length: n }, (_, k) => {
    const mid = y0 + (k + 0.5) * step;
    const seam = k > 0 ? [box(l - 0.03, 0.008, 0.006, 0, y0 + k * step, z, "detail")] : [];
    return [...seam, box(Math.min(0.14, l * 0.4), 0.018, 0.02, 0, mid + step * 0.25, z + 0.008, "detail")];
  }).flat();
}
/** 正面 n 扇门：门缝与靠缝的竖拉手，自 y0 到 y1；handleY 为拉手高度 */
function doors(l: number, w: number, y0: number, y1: number, n: number, handleY = (y0 + y1) / 2): Piece[] {
  const z = w / 2 + 0.004;
  const width = l / n;
  const pieces: Piece[] = [];
  const handle = Math.min(0.3, (y1 - y0) * 0.25);
  for (let k = 0; k < n; k += 1) {
    const left = -l / 2 + k * width;
    if (k > 0) pieces.push(box(0.008, y1 - y0 - 0.02, 0.006, left, (y0 + y1) / 2, z, "detail"));
    // 成对的门拉手靠中缝，单扇的靠右
    const side = n === 1 ? 1 : k % 2 === 0 ? 1 : -1;
    pieces.push(box(0.02, handle, 0.02, left + width / 2 + side * (width / 2 - 0.05), clamp(handleY, y0 + handle, y1 - handle), z + 0.008, "detail"));
  }
  return pieces;
}

function table(style: Style, l: number, w: number, h: number): Piece[] {
  switch (style) {
    case "coffee": {
      const height = clamp(h, 0.3, 0.55);
      return [box(l, 0.05, w, 0, height - 0.025, 0), box(l - 0.1, 0.02, w - 0.1, 0, 0.12, 0, "frame"), ...legs(l, w, height - 0.05, 0.04)];
    }
    case "desk": {
      const pieces = [
        box(l, TOP, w, 0, h - TOP / 2, 0),
        ...[-1, 1].map((i) => column(0.03, w - 0.04, i * (l / 2 - 0.03), 0, 0, h - TOP)),
        // 挡板在背面（−z）
        column(l - 0.08, 0.02, 0, -(w / 2 - 0.06), h - TOP - 0.35, h - TOP),
      ];
      if (l >= 1.1) {
        // 一侧的抽屉柜：三个抽屉
        const [pl, pw] = [0.4, w - 0.1];
        const x = l / 2 - 0.05 - pl / 2;
        const top = h - TOP - 0.02;
        pieces.push(box(pl, top - 0.04, pw, x, 0.04 + (top - 0.04) / 2, 0));
        pieces.push(...drawers(pl, pw, 0.04, top, 3).map((p) => ({ ...p, at: [p.at[0] + x, p.at[1], p.at[2]] as Piece["at"] })));
      }
      return pieces;
    }
    case "conference": {
      const top = 0.05;
      const n = Math.max(2, Math.ceil(l / 1.6) + 1);
      const span = l - 0.5;
      return [
        box(l, top, w, 0, h - top / 2, 0),
        ...Array.from({ length: n }, (_, k) => column(0.06, w * 0.6, -span / 2 + (k * span) / (n - 1), 0, 0, h - top)),
        box(span, 0.06, 0.06, 0, 0.25, 0, "frame"),
      ];
    }
    case "round": {
      const r = (l + w) / 4;
      return [
        cylinder(r, TOP, 0, h - TOP / 2, 0),
        cylinder(0.05, h - TOP - 0.03, 0, (h - TOP - 0.03) / 2 + 0.03, 0, "frame"),
        cylinder(Math.min(0.3, r * 0.6), 0.03, 0, 0.015, 0, "frame"),
      ];
    }
    case "bar": {
      const height = clamp(h, 0.95, 1.15);
      if (l <= 1.0) {
        const r = (l + w) / 4;
        return [
          cylinder(r, TOP, 0, height - TOP / 2, 0),
          cylinder(0.04, height - TOP - 0.02, 0, (height - TOP) / 2, 0, "frame"),
          cylinder(Math.min(0.25, r * 0.8), 0.02, 0, 0.01, 0, "frame"),
        ];
      }
      return [
        box(l, TOP, w, 0, height - TOP / 2, 0),
        ...legs(l, w, height - TOP),
        // 长边两侧的搁脚横杆
        ...[-1, 1].map((j) => box(l - 2 * LEG, 0.03, 0.03, 0, 0.25, j * (w / 2 - LEG), "frame")),
      ];
    }
    default:
      // 四腿餐桌：桌面、望板、四条腿
      return [box(l, TOP, w, 0, h - TOP / 2, 0), box(l - 0.12, 0.08, w - 0.12, 0, h - TOP - 0.04, 0, "frame"), ...legs(l, w, h - TOP, 0.06)];
  }
}

function seat(style: Style, l: number, w: number, h: number): Piece[] {
  switch (style) {
    case "stool": {
      const height = clamp(h, 0.4, 0.55);
      const r = clamp(Math.min(l, w) / 2, 0.15, 0.22);
      const foot = r * 0.75;
      return [
        cylinder(r, 0.04, 0, height - 0.02, 0),
        ...[1, 3, 5, 7].map((k) => {
          const a = (k * Math.PI) / 4;
          return cylinder(0.015, height - 0.04, foot * Math.cos(a), (height - 0.04) / 2, foot * Math.sin(a), "frame");
        }),
        box(foot * 2, 0.02, 0.02, 0, height * 0.35, 0, "frame", Math.PI / 4),
        box(foot * 2, 0.02, 0.02, 0, height * 0.35, 0, "frame", -Math.PI / 4),
      ];
    }
    case "barstool": {
      const height = clamp(h, 0.62, 0.85);
      return [
        cylinder(0.2, 0.05, 0, height - 0.025, 0),
        cylinder(0.03, height - 0.07, 0, (height - 0.05) / 2, 0, "frame"),
        cylinder(0.22, 0.02, 0, 0.01, 0, "frame"),
        { shape: "torus", size: [0.17, 0.012, 0], at: [0, height * 0.4, 0], tone: "frame" },
      ];
    }
    case "swivel": {
      const back = clamp(h, 0.85, 1.25);
      const s = 0.47;
      return [
        box(0.48, 0.07, 0.46, 0, s, 0.02),
        box(0.44, back - s - 0.12, 0.05, 0, (s + 0.12 + back) / 2, -0.22),
        column(0.05, 0.03, 0, -0.2, s, s + 0.14),
        // 扶手：立柱与托板
        ...[-1, 1].flatMap((i) => [column(0.03, 0.03, i * 0.25, 0.02, s, s + 0.2), box(0.05, 0.03, 0.26, i * 0.25, s + 0.215, 0.04, "frame")]),
        cylinder(0.025, s - 0.1, 0, (s + 0.1) / 2 - 0.03, 0, "frame"),
        // 五星脚与脚轮
        ...Array.from({ length: 5 }, (_, k) => {
          const a = (k * 2 * Math.PI) / 5;
          return [
            box(0.3, 0.03, 0.04, 0.15 * Math.cos(a), 0.07, -0.15 * Math.sin(a), "frame", a),
            cylinder(0.025, 0.04, 0.29 * Math.cos(a), 0.02, -0.29 * Math.sin(a), "detail"),
          ];
        }).flat(),
      ];
    }
    case "armchair": {
      const [L, W, H] = [clamp(l, 0.75, 1.0), clamp(w, 0.7, 0.95), clamp(h, 0.75, 1.0)];
      const arm = 0.15;
      return [
        box(L, 0.26, W, 0, 0.08 + 0.13, 0),
        box(L - 2 * arm, 0.12, W - 0.2, 0, 0.4, 0.05),
        box(L, H - 0.08, 0.18, 0, 0.08 + (H - 0.08) / 2, -(W / 2 - 0.09)),
        ...[-1, 1].map((i) => box(arm, 0.52, W, i * (L / 2 - arm / 2), 0.08 + 0.26, 0)),
        ...legs(L, W, 0.08, 0.06, 0.04),
      ];
    }
    case "bench": {
      const W = Math.min(w, 0.45);
      const pieces = [box(l, 0.05, W, 0, 0.45, 0), ...[-1, 1].map((i) => column(0.05, W - 0.05, i * (l / 2 - 0.12), 0, 0, 0.425))];
      if (h >= 0.7)
        pieces.push(
          box(l, 0.22, 0.04, 0, 0.62, -(W / 2 - 0.02)),
          ...[-1, 1].map((i) => column(0.04, 0.04, i * (l / 2 - 0.12), -(W / 2 - 0.02), 0.475, 0.73)),
        );
      return pieces;
    }
    default: {
      // 四腿靠背椅
      const back = Math.max(h, 0.8);
      return [
        box(l, TOP, w, 0, 0.45, 0),
        box(l, back - 0.5, TOP, 0, (0.5 + back) / 2, -(w / 2 - TOP / 2)),
        ...[-1, 1].map((i) => column(0.03, 0.03, i * (l / 2 - 0.03), -(w / 2 - 0.03), 0.47, 0.52)),
        ...legs(l, w, 0.43, 0.03, 0.035),
      ];
    }
  }
}

function storage(style: Style, l: number, w: number, h: number): Piece[] {
  const plinth = 0.06;
  const body = (height = h) => [box(l, height - plinth, w, 0, plinth + (height - plinth) / 2, 0), box(l - 0.04, plinth, w - 0.04, 0, plinth / 2, 0, "frame")];
  switch (style) {
    case "bookcase": {
      const t = 0.025;
      const n = clamp(Math.round(h / 0.35) - 1, 1, 6);
      const gap = (h - plinth - t) / (n + 1);
      const pieces = [
        ...[-1, 1].map((i) => column(t, w, i * (l / 2 - t / 2), 0, 0, h, "body")),
        box(l, t, w, 0, h - t / 2, 0),
        box(l - 2 * t, plinth, w, 0, plinth / 2, 0, "frame"),
        box(l - 2 * t, h - plinth - t, 0.01, 0, plinth + (h - plinth - t) / 2, -w / 2 + 0.005, "frame"),
      ];
      const inner = l - 2 * t;
      for (let k = 0; k <= n; k += 1) {
        const floor = plinth + k * gap;
        if (k > 0) pieces.push(box(inner, t, w - 0.01, 0, floor, 0.005));
        // 每层两三摞书，位置按层号错开（确定性，逐次识别不跳动）
        const stacks = 2 + (k % 2);
        for (let b = 0; b < stacks; b += 1) {
          const bw = inner * (0.18 + 0.06 * ((k + b) % 3));
          const x = -inner / 2 + ((b + 0.5) * inner) / stacks + (((k * 7 + b * 3) % 5) - 2) * 0.02;
          const bh = gap * (0.55 + 0.1 * ((k + 2 * b) % 3));
          pieces.push(box(Math.min(bw, inner / stacks - 0.02), bh, w * 0.7, x, floor + t / 2 + bh / 2, 0, "detail"));
        }
      }
      return pieces;
    }
    case "wardrobe": {
      const n = Math.max(2, Math.round(l / 0.5));
      return [...body(), box(l + 0.02, 0.03, w + 0.02, 0, h - 0.015, 0, "frame"), ...doors(l, w, plinth, h - 0.03, n, 1.05)];
    }
    case "drawers":
    case "file": {
      const n = clamp(Math.round((h - plinth) / (style === "file" ? 0.32 : 0.22)), 2, 6);
      return [...body(), ...drawers(l, w, plinth, h, n)];
    }
    case "sideboard": {
      const n = clamp(Math.round(l / 0.5), 2, 4);
      return [...body(h - 0.03), box(l + 0.02, 0.03, w + 0.02, 0, h - 0.015, 0), ...doors(l, w, plinth, h - 0.03, n)];
    }
    default:
      return [...body(), ...doors(l, w, plinth, h, l > 0.7 ? 2 : 1)];
  }
}

function sofa(l: number, w: number, h: number): Piece[] {
  const [W, H] = [clamp(w, 0.7, 1.0), clamp(h, 0.7, 0.95)];
  const arm = 0.2;
  const n = clamp(Math.round((l - 2 * arm) / 0.6), 1, 4);
  const cushion = (l - 2 * arm) / n;
  return [
    box(l, 0.3, W, 0, 0.08 + 0.15, 0, "frame"),
    ...Array.from({ length: n }, (_, k) => box(cushion - 0.02, 0.12, W - 0.25, -l / 2 + arm + (k + 0.5) * cushion, 0.44, 0.1)),
    box(l, H - 0.08, 0.2, 0, 0.08 + (H - 0.08) / 2, -(W / 2 - 0.1)),
    ...Array.from({ length: n }, (_, k) => box(cushion - 0.04, 0.32, 0.12, -l / 2 + arm + (k + 0.5) * cushion, 0.66, -(W / 2 - 0.26))),
    ...[-1, 1].map((i) => box(arm, 0.55, W, i * (l / 2 - arm / 2), 0.08 + 0.275, 0)),
    ...legs(l, W, 0.08, 0.06, 0.04),
  ];
}

function bed(l: number, w: number, h: number): Piece[] {
  const pillows = w >= 1.2 ? 2 : 1;
  const head = -l / 2;
  // 床头比床面高出一截；实测高度多是床面（被床头抬高的也在范围内）
  const board = clamp(h + 0.25, 0.75, 1.2);
  return [
    box(l, 0.3, w, 0, 0.15, 0, "frame"),
    box(l - 0.08, 0.2, w - 0.06, 0.02, 0.4, 0),
    box(0.06, board, w, head + 0.03, board / 2, 0, "frame"),
    ...Array.from({ length: pillows }, (_, k) => box(0.35, 0.1, w / pillows - 0.12, head + 0.3, 0.55, -w / 2 + (k + 0.5) * (w / pillows))),
    // 被子盖住床的后三分之二
    box((l - 0.08) * 0.62, 0.04, w - 0.04, l / 2 - 0.04 - ((l - 0.08) * 0.62) / 2, 0.52, 0, "detail"),
  ];
}

/**
 * 物体的零件；length、width 为底面实测长宽（length ≥ width）。椅子截断到常见尺寸（底面常连带坐着的人），
 * 连成一片的按间距排开多把（chairCount）；其余截断到 OBJECT_MAX_M
 */
export function furniture(cls: SceneFrame["objects"][number]["class"], kind: Kind | null | undefined, length: number, width: number, height: number): { style: Style; pieces: Piece[] } {
  const style = styleOf(cls, kind, length, width, height);
  if (cls === "chair" && style !== "armchair" && style !== "bench") {
    const [L, W] = [Math.min(length, OBJECT_MAX_M), Math.min(width, OBJECT_MAX_M)];
    const [nx, nz] = [chairCount(L), W >= CHAIR_BLOCK_MIN_M ? chairCount(W) : 1];
    if (nx * nz > 1) {
      const one = furniture(cls, kind, L / nx, W / nz, height).pieces;
      const pieces = Array.from({ length: nx * nz }, (_, k) => {
        const [dx, dz] = [-L / 2 + ((k % nx) + 0.5) * (L / nx), -W / 2 + (Math.floor(k / nx) + 0.5) * (W / nz)];
        return one.map((p): Piece => ({ ...p, at: [p.at[0] + dx, p.at[1], p.at[2] + dz] }));
      }).flat();
      return { style, pieces };
    }
  }
  const cap = style === "bench" ? 2.5 : cls === "chair" && style !== "armchair" ? CHAIR_MAX_M : OBJECT_MAX_M;
  const [l, w, h] = [Math.max(Math.min(length, cap), 0.2), Math.max(Math.min(width, cap), 0.2), height];
  switch (style) {
    case "dining":
    case "desk":
    case "conference":
    case "round":
    case "coffee":
    case "bar":
      return { style, pieces: table(style, l, w, h) };
    case "chair":
    case "swivel":
    case "stool":
    case "barstool":
    case "armchair":
    case "bench":
      return { style, pieces: seat(style, l, w, h) };
    case "cabinet":
    case "file":
    case "drawers":
    case "sideboard":
    case "wardrobe":
    case "bookcase":
      return { style, pieces: storage(style, l, w, h) };
    case "sofa":
      return { style, pieces: sofa(l, w, h) };
    case "bed":
      return { style, pieces: bed(l, w, h) };
    case "counter":
      return { style, pieces: [box(l, h - TOP, w - 0.05, 0, (h - TOP) / 2, -0.025), box(l + 0.04, TOP, w, 0, h - TOP / 2, 0, "frame")] };
    case "ashcan": {
      const r = clamp(Math.min(l, w) / 2, 0.15, 0.3);
      const height = clamp(h, 0.6, 1.0);
      return { style, pieces: [cylinder(r, height - 0.04, 0, (height - 0.04) / 2, 0, "body", r * 0.85), cylinder(r + 0.01, 0.04, 0, height - 0.02, 0, "frame")] };
    }
    case "pole":
      return { style, pieces: [cylinder(0.05, h, 0, h / 2, 0, "frame"), box(0.25, 0.1, 0.2, 0, h - 0.05, 0)] };
    default:
      return { style, pieces: [box(l, h, w, 0, h / 2, 0)] };
  }
}
