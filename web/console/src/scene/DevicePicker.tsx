import { select, useSelection } from "../store/selection";
import { useViewpointCamera } from "./camera";
import type { Camera } from "./devices";
import type { View } from "./layout";

/** 命中区域的最小边长，单位像素 */
const MIN_PX = 40;
/** 机头最大尺寸约 1 米（DeviceMarkers 的 HEAD） */
const HEAD_M = 1;

/**
 * 单击设备选中并展开详情（V-I2）：机头位置放一个透明按钮，命中区域不小于机头视觉尺寸（V-I4），
 * 键盘同样可选；悬停显示与选中同款的浅色圆环。双击飞入摄像头视角（onFocus，仅 3D 场景，V-I1）；列表联动由 #60 接入。
 */
export function DevicePicker(props: { cameras: Camera[]; view: View; onFocus?: (id: string) => void }) {
  const { cameras, view, onFocus } = props;
  const selected = useSelection((s) => s.deviceId);
  const viewing = useViewpointCamera(); // 模型不画，按钮随之不放
  return cameras.map(({ id, pose }) => {
    const head = [pose.x, pose.height_m, pose.y] as const;
    const at = view.project(head);
    if (!at || id === viewing) return null;
    const [left, top] = at;
    const size = Math.max(MIN_PX, HEAD_M * view.scale(head));
    return (
      <button
        key={id}
        aria-label={`查看 ${id} 详情`}
        aria-pressed={selected === id}
        onClick={() => select(id)}
        onDoubleClick={() => onFocus?.(id)}
        style={{ left, top, width: size, height: size }}
        className="absolute -translate-1/2 rounded-full outline-offset-2 hover:ring-2 hover:ring-fg/40 focus-visible:outline-2 focus-visible:outline-fg aria-pressed:ring-2 aria-pressed:ring-fg/40"
      />
    );
  });
}
