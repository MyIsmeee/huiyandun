import { select, useSelection } from "../store/selection";
import type { Camera } from "./devices";
import type { View } from "./layout";

/** 命中区域的最小边长，单位像素 */
const MIN_PX = 40;
/** 机头最大尺寸约 1 米（DeviceMarkers 的 HEAD） */
const HEAD_M = 1;

/**
 * 单击设备选中并展开详情（V-I2）：机头位置放一个透明按钮，命中区域不小于机头视觉尺寸（V-I4），
 * 键盘同样可选。双击聚焦、悬停高亮与列表联动由 #60 接入。
 */
export function DevicePicker({ cameras, view }: { cameras: Camera[]; view: View }) {
  const selected = useSelection((s) => s.deviceId);
  const size = Math.max(MIN_PX, HEAD_M * view.zoom);
  return cameras.map(({ id, pose }) => {
    const [left, top] = view.project([pose.x, pose.height_m, pose.y]);
    return (
      <button
        key={id}
        aria-label={`查看 ${id} 详情`}
        aria-pressed={selected === id}
        onClick={() => select(id)}
        style={{ left, top, width: size, height: size }}
        className="absolute -translate-1/2 rounded-full outline-offset-2 focus-visible:outline-2 focus-visible:outline-fg aria-pressed:ring-2 aria-pressed:ring-fg/40"
      />
    );
  });
}
