/** 编辑视图的相机操作，由 3D 画布提供给页面上的视角控件；不引入 three，页面主包保持轻量 */
export interface EditorView {
  zoom: (direction: 1 | -1, animate: boolean) => void;
  /** 绕区域中心顺时针转 90° */
  rotate: (animate: boolean) => void;
  /** 回到总览：默认方位、俯视 45°，整个区域在画面内 */
  home: (animate: boolean) => void;
}
