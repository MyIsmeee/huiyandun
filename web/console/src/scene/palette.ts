import { useTheme } from "../theme/store";
import { MATERIALS, OUTLINE } from "./assets";
import { BEAM } from "./devices";
import { FILL } from "./targets";

/**
 * 场景随主题变化的那部分外观：背景、不受光的地面与边线、光照，以及常态视场与常态目标的颜色。
 * 状态色（物理告警、网络攻击、已处置）语义固定，两套主题下相同（V-S2），不在其中。
 */
export interface ScenePalette {
  /** 场景背景，与页面底色 --background 一致；远处渐隐取同色 */
  background: string;
  /** 地面（不受光） */
  ground: string;
  /** 区域边线 */
  outline: string;
  /** 常态视场 */
  beam: string;
  /** 常态人员与车辆 */
  target: string;
  /** 半球光：天空色、地面色、强度 */
  hemi: readonly [string, string, number];
  /** 平行主光：颜色、强度 */
  sun: readonly [string, number];
  /** 阴影承接面的不透明度 */
  shadow: number;
  /** 常态视场不透明度的倍数 */
  coneGain: number;
  /** 告警与处置状态的视场不透明度的倍数：只加浓，颜色与混合方式不变，状态色保持本色（V-S2） */
  statusGain: number;
  /** 常态视场以叠加混合绘制，在深色背景上呈现为发光的光束 */
  glow: boolean;
}

/** 日间（D-111、设计 150 §4）：取值即各处原有的常量，渲染结果不变 */
export const DAY: ScenePalette = {
  background: "#F4F5F7",
  ground: MATERIALS.ground,
  outline: OUTLINE,
  beam: BEAM,
  target: FILL,
  hemi: ["#FFFFFF", "#E5E7EB", 1.5],
  sun: ["#FFFFFF", 2],
  shadow: 0.25,
  coneGain: 1,
  statusGain: 1,
  glow: false,
};

/**
 * 夜间警戒：深色背景、冷色弱光——白模呈蓝灰色，朝上的受光面约为日间亮度的三成；常态视场改为发光的蓝色光束，
 * 受击变红、处置转绿时在暗场景里一眼可辨。常态目标改用浅色，否则中性深灰的人形在弱光下看不见。
 */
export const NIGHT: ScenePalette = {
  background: "#0B1220",
  ground: "#141D30",
  outline: "#3A4A6B",
  beam: "#3B82F6",
  target: "#C7D2E5",
  hemi: ["#6F86B8", "#141D30", 0.9],
  sun: ["#9DB4E8", 0.7],
  shadow: 0.45,
  coneGain: 2.2,
  statusGain: 1.6,
  glow: true,
};

export function useScenePalette(): ScenePalette {
  return useTheme((s) => s.night) ? NIGHT : DAY;
}
